import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { run } from './ffmpeg.js';

const b64 = (f) => fs.readFileSync(f).toString('base64');
const mime = (f) => (f.endsWith('.png') ? 'image/png' : 'image/jpeg');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

// When Rawcut is started from inside another Claude Code / Claude app session, that session's
// settings (CLAUDE_CODE_*, ANTHROPIC_MODEL=auto, ...) leak in through the environment and break
// the `claude` CLI. Run it with those removed so it uses the user's own login and settings.
function cleanClaudeEnv() {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_AGENT_SDK|ANTHROPIC_MODEL$|ANTHROPIC_SMALL_FAST_MODEL$|ANTHROPIC_DEFAULT_)/.test(k)) env[k] = undefined;
  }
  return env;
}

// Signs that a custom Claude Code setup (proxy, gateway, odd model name) is what failed.
const BROKEN_SETUP = /unrecognized_model|ECONNREFUSED|connection (error|refused)|could not connect|fetch failed|ENOTFOUND|socket hang up|ANTHROPIC_BASE_URL|gateway|invalid model|model .*not (found|available)/i;

const NO_VISION = /image|vision|multimodal|multi-modal|does not support|not support/i;

// Is a proxy/gateway configured for Claude Code (in ~/.claude/settings.json or the environment)
// but not answering? Then `claude` would hang retrying it, so go straight to the normal login.
async function claudeGatewayDown() {
  let url = process.env.ANTHROPIC_BASE_URL;
  try {
    const f = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(f)) url = JSON.parse(fs.readFileSync(f, 'utf8'))?.env?.ANTHROPIC_BASE_URL || url;
  } catch { }
  if (!url) return false;
  let u; try { u = new URL(url); } catch { return false; }
  const port = +u.port || (u.protocol === 'https:' ? 443 : 80);
  return new Promise((resolve) => {
    const sock = net.connect({ host: u.hostname, port, timeout: 2500 });
    const done = (down) => { sock.destroy(); resolve(down); };
    sock.once('connect', () => done(false));
    sock.once('timeout', () => done(true));
    sock.once('error', () => done(true));
  });
}

function cliPrompt(system, prompt, imgs, tellRead = true) {
  let s = `${system}\n\n${prompt}`;
  if (imgs.length && tellRead) s += `\n\nIMPORTANT: Before answering, open and look at each of these video frame images with your Read tool. They are frames from the video:\n${imgs.map((f) => '- ' + f).join('\n')}`;
  return s + '\n\nRespond with ONLY the JSON object. No prose, no markdown fences.';
}

/** One completion from whichever "brain" the user connected. Returns raw text. */
export async function complete(cfg, { system, prompt, images = [], cwd, log }) {
  const L = cfg.llm;
  const imgs = L.vision === false ? [] : images.filter((f) => fs.existsSync(f));
  switch (L.provider) {
    case 'anthropic': {
      if (!L.anthropic.key) throw new Error('Add your Anthropic API key in Settings.');
      const content = [...imgs.map((f) => ({ type: 'image', source: { type: 'base64', media_type: mime(f), data: b64(f) } })), { type: 'text', text: prompt }];
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': L.anthropic.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: L.anthropic.model, max_tokens: 12000, system, messages: [{ role: 'user', content }] }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('Anthropic: ' + (d.error?.message || r.status));
      return d.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    }
    case 'openai': {
      const O = L.openai;
      const call = async (withImgs) => {
        const content = [{ type: 'text', text: prompt }, ...imgs.map((f) => ({ type: 'image_url', image_url: { url: `data:${mime(f)};base64,${b64(f)}` } }))];
        const r = await fetch(`${O.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(O.key ? { authorization: `Bearer ${O.key}` } : {}) },
          body: JSON.stringify({ model: O.model, messages: [{ role: 'system', content: system }, { role: 'user', content: withImgs ? content : prompt }] }),
        }).catch((e) => { throw new Error(`Can't reach ${O.baseUrl} (${e.message}). Check the base URL in Settings.`); });
        const d = await r.json().catch(() => ({}));
        return { ok: r.ok, status: r.status, err: d.error?.message || (typeof d.error === 'string' ? d.error : '') || d.message || '', text: d.choices?.[0]?.message?.content || '' };
      };
      let res = await call(imgs.length > 0);
      // Many local / third-party models are text-only and reject images: retry without frames.
      if (!res.ok && imgs.length && NO_VISION.test(res.err)) res = await call(false);
      if (!res.ok) throw new Error('OpenAI-compatible: ' + (res.err || res.status));
      return res.text;
    }
    case 'ollama': {
      const O = L.ollama;
      const base = (O.url || 'http://127.0.0.1:11434').replace(/\/$/, '');
      // Streamed so slow local models never hit fetch's 5-minute "no response yet" timeout.
      const call = async (withImgs) => {
        const r = await fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: O.model, stream: true, format: 'json', options: { num_ctx: 32768, temperature: 0.3 },
            messages: [{ role: 'system', content: system }, { role: 'user', content: prompt, ...(withImgs ? { images: imgs.map(b64) } : {}) }],
          }),
        }).catch((e) => { throw new Error(`Ollama isn't reachable at ${base} (${e.message}). Open the Ollama app or run \`ollama serve\`.`); });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          return { ok: false, err: d.error || String(r.status) };
        }
        let text = '', buf = '', err = '';
        const dec = new TextDecoder();
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line) continue;
            try { const j = JSON.parse(line); if (j.error) err = j.error; text += j.message?.content || ''; } catch { }
          }
        }
        if (buf.trim()) { try { const j = JSON.parse(buf); if (j.error) err = j.error; text += j.message?.content || ''; } catch { } }
        return err && !text ? { ok: false, err } : { ok: true, text };
      };
      let res = await call(imgs.length > 0);
      if (!res.ok && imgs.length && NO_VISION.test(res.err)) res = await call(false);
      if (!res.ok) {
        const e = String(res.err);
        if (/not found|pull/i.test(e)) throw new Error(`Ollama: model "${O.model}" isn't downloaded. Run \`ollama pull ${O.model}\` or pick one you have in Settings.`);
        throw new Error('Ollama: ' + e);
      }
      return res.text;
    }
    case 'claudecode': {
      const ask = (extra, model, env) => {
        const args = ['-p', '--output-format', 'text', '--allowedTools', 'Read', ...extra];
        if (model) args.push('--model', model);
        return run('claude', args, { input: cliPrompt(system, prompt, imgs), cwd, timeout: 20 * 60e3, env })
          .catch((e) => { throw new Error('Claude Code CLI not found. Install it and run `claude` once to log in. ' + e.message); });
      };
      const failed = (r) => r.code !== 0 && !r.stdout.includes('{');
      const errText = (r) => stripAnsi(r.stderr || r.stdout).slice(-800);
      // Some people route Claude Code through a proxy or gateway in ~/.claude/settings.json
      // (custom base URL, model "auto", ...). If that setup is broken or not running, use only
      // Claude Code's normal login instead: skip the user settings file and name a real model.
      const plain = () => ask(['--setting-sources', 'project,local'], L.claudecode.model || 'claude-sonnet-5-5',
        { ...cleanClaudeEnv(), ANTHROPIC_BASE_URL: undefined, ANTHROPIC_AUTH_TOKEN: undefined });
      if (await claudeGatewayDown()) {
        log?.('Your Claude Code proxy/gateway isn\'t running, so using your normal Claude login.');
        const r0 = await plain();
        if (failed(r0)) throw new Error('Claude Code: ' + errText(r0) + ' — Your Claude Code settings point to a proxy/gateway (ANTHROPIC_BASE_URL in ~/.claude/settings.json) that isn\'t running. Start it, or run `claude` once in a terminal to log in normally.');
        return stripAnsi(r0.stdout);
      }
      let r = await ask([], L.claudecode.model, cleanClaudeEnv());
      if (failed(r) && BROKEN_SETUP.test(errText(r))) {
        log?.('Claude Code failed with your custom Claude Code settings; retrying with your normal Claude login…');
        const retry = await plain();
        if (!failed(retry)) return stripAnsi(retry.stdout);
        r = { ...r, retryErr: errText(retry).slice(-300) };
      }
      if (failed(r)) {
        const msg = errText(r) + (r.retryErr ? `\n(Also tried your normal Claude login, which failed: ${r.retryErr})` : '');
        throw new Error('Claude Code: ' + msg + (/model/i.test(msg) ? ' — Tip: type a model name in Settings (e.g. claude-sonnet-5-5).' : / log ?in|auth/i.test(msg) ? ' — Run `claude` in a terminal once to log in.' : ''));
      }
      return stripAnsi(r.stdout);
    }
    case 'codex': {
      const out = path.join(cwd, `.codex_out_${Date.now()}.txt`);
      const args = ['exec', '--skip-git-repo-check', '-o', out];
      if (L.codex.model) args.push('-m', L.codex.model);
      args.push('-');
      if (imgs.length) args.push('-i', imgs.join(','));
      const r = await run('codex', args, { input: cliPrompt(system, prompt, imgs, false), cwd, timeout: 20 * 60e3 })
        .catch((e) => { throw new Error('Codex CLI not found. Install it (npm i -g @openai/codex) and log in. ' + e.message); });
      const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
      fs.rmSync(out, { force: true });
      if (r.code !== 0 && !text) {
        const msg = stripAnsi(r.stderr || r.stdout).slice(-800);
        throw new Error('Codex: ' + msg + (/log ?in|auth|401|unauthori/i.test(msg) ? ' — Run `codex login` in a terminal once.' : /model/i.test(msg) ? ' — Check the model name in Settings, or leave it empty.' : ''));
      }
      return text || stripAnsi(r.stdout);
    }
    case 'custom': {
      const r = await run(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/d', '/s', '/c', L.custom.command] : ['-c', L.custom.command], { input: cliPrompt(system, prompt, imgs), cwd, timeout: 20 * 60e3 });
      if (r.code !== 0) throw new Error('Custom command failed: ' + (r.stderr || r.stdout).slice(-800));
      return stripAnsi(r.stdout);
    }
    default:
      throw new Error('Unknown AI provider: ' + L.provider);
  }
}

export function extractJSON(text) {
  let s = String(text || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('No JSON object in model output');
  s = s.slice(a, b + 1);
  try { return JSON.parse(s); }
  catch { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); }
}

export async function askJSON(cfg, opts, log = () => {}) {
  const text = await complete(cfg, { log, ...opts });
  try { return extractJSON(text); }
  catch (e) {
    log('Model returned invalid JSON, asking it to fix…');
    const fixed = await complete(cfg, {
      log, ...opts, images: [],
      prompt: `This was supposed to be one valid JSON object but failed to parse (${e.message}). Return the corrected JSON ONLY.\n\n${text.slice(0, 60000)}`,
    });
    return extractJSON(fixed);
  }
}
