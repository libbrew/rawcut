import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { ROOT, PROJECTS, MODELS, loadConfig, saveConfig } from './lib/config.js';
import * as F from './lib/ffmpeg.js';
import { transcribe, WHISPER_MODELS, modelUrl } from './lib/transcribe.js';
import { understand, makePlan, revisePlan, buildTimeline, transcriptLines, carryManual } from './lib/brain.js';
import { resolvePlanMedia, search, download } from './lib/media.js';
import { run, which, ffmpegInfo } from './lib/ffmpeg.js';
import { complete } from './lib/llm.js';
import { fixPath } from './lib/env.js';

fixPath(); // apps opened from the Dock/Start menu don't get your shell's PATH, so find claude/codex/ollama anyway

const PORT = +(process.env.PORT ?? 4777);
const app = express();

// Rawcut only talks to this computer. Refuse requests from other websites (CSRF) and
// from DNS-rebinding tricks, because the API can run your AI CLI and read your keys.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
app.use((req, res, next) => {
  if (!LOCAL_HOST.test(req.headers.host || '')) return res.status(403).send('Rawcut only accepts requests addressed to localhost.');
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let ok = false; try { ok = LOCAL_HOST.test(new URL(origin).host); } catch { }
    if (!ok) return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-site request blocked.' });
  next();
});
app.use(express.json({ limit: '800mb' }));
app.use(express.static(path.join(ROOT, 'public'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
app.use('/files', express.static(PROJECTS));

// ------------------------------------------------------------------ helpers
const jobs = new Map();
function startJob(projectId, kind, fn) {
  const job = { id: crypto.randomUUID().slice(0, 8), projectId, kind, status: 'running', log: [], step: '', progress: 0, error: null, started: Date.now() };
  jobs.set(job.id, job);
  const ctx = {
    log: (m) => { job.log.push({ t: Date.now(), m }); console.log(`[${kind}:${projectId || ''}] ${m}`); },
    step: (s) => { job.step = s; ctx.log('▸ ' + s); },
    progress: (x) => { job.progress = x; },
  };
  if (projectId) { const p = loadP(projectId); p.jobId = job.id; saveP(p); }
  fn(ctx).then(() => { job.status = 'done'; job.progress = 1; })
    .catch((e) => { job.status = 'error'; job.error = e.message; ctx.log('✖ ' + e.message); console.error(e); });
  return job;
}

const pdir = (id) => path.join(PROJECTS, id.replace(/[^a-z0-9-]/gi, ''));
function loadP(id) { const p = JSON.parse(fs.readFileSync(path.join(pdir(id), 'project.json'), 'utf8')); Object.defineProperty(p, '_dir', { value: pdir(id), enumerable: false }); return p; }
function saveP(p) { fs.writeFileSync(path.join(pdir(p.id), 'project.json'), JSON.stringify(p, null, 1)); }
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error(e); res.status(500).json({ error: e.message }); });

// ------------------------------------------------------------------ config & status
app.get('/api/config', (req, res) => res.json(loadConfig()));
app.put('/api/config', (req, res) => res.json(saveConfig(req.body)));

app.get('/api/status', wrap(async (req, res) => {
  const cfg = loadConfig();
  const [whisper, claude, codex] = ['whisper-cli', 'claude', 'codex'].map((c) => !!which(c));
  const ffmpeg = ffmpegInfo();
  let ollama = null;
  try { const r = await fetch(cfg.llm.ollama.url.replace(/\/$/, '') + '/api/tags', { signal: AbortSignal.timeout(1500) }); ollama = (await r.json()).models.map((m) => m.name); } catch { }
  const models = Object.entries(WHISPER_MODELS).map(([name, desc]) => ({ name, desc, installed: fs.existsSync(path.join(MODELS, name)) }));
  const L = cfg.llm;
  const brainReady = { claudecode: claude, codex, ollama: !!ollama?.length, anthropic: !!L.anthropic.key, openai: !!(L.openai.key || /localhost|127\.0\.0\.1/.test(L.openai.baseUrl)), custom: !!L.custom.command }[L.provider] ?? false;
  res.json({ ffmpeg, whisper, claude, codex, ollama, models, brainReady, platform: process.platform });
}));

app.post('/api/models/download', wrap(async (req, res) => {
  const name = req.body.name;
  if (!WHISPER_MODELS[name]) return res.status(400).json({ error: 'unknown model' });
  const job = startJob(null, 'model', async (ctx) => {
    ctx.step(`Downloading ${name} from huggingface.co/ggerganov/whisper.cpp`);
    const r = await fetch(modelUrl(name));
    if (!r.ok) throw new Error('download failed ' + r.status);
    const total = +r.headers.get('content-length') || 0; let got = 0;
    const tmp = path.join(MODELS, name + '.part');
    const body = Readable.fromWeb(r.body);
    body.on('data', (c) => { got += c.length; if (total) ctx.progress(got / total); });
    await pipeline(body, fs.createWriteStream(tmp));
    fs.renameSync(tmp, path.join(MODELS, name));
    ctx.log('Model ready.');
  });
  res.json({ jobId: job.id });
}));

// Quick "is my AI connected?" check for the Settings page.
app.post('/api/test-brain', wrap(async (req, res) => {
  const cfg = loadConfig(); const t0 = Date.now();
  try {
    const text = await complete(cfg, { system: 'You are a connection test.', prompt: 'Reply with exactly this JSON: {"ok": true}', cwd: PROJECTS });
    res.json({ ok: /ok/i.test(text), ms: Date.now() - t0, reply: text.slice(0, 200) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
}));

app.get('/api/jobs/:id', (req, res) => { const j = jobs.get(req.params.id); j ? res.json(j) : res.status(404).json({ error: 'no such job' }); });

// ------------------------------------------------------------------ projects
app.get('/api/projects', (req, res) => {
  const list = fs.readdirSync(PROJECTS).filter((d) => fs.existsSync(path.join(PROJECTS, d, 'project.json'))).map((d) => {
    const p = loadP(d);
    return { id: p.id, name: p.understanding?.title || p.name, created: p.created, duration: p.duration, status: p.status, thumb: p.frames?.[0] ? `/files/${p.id}/${p.frames[0].file}` : null, renders: p.renders?.length || 0, edited: p.renders?.at(-1)?.duration || null };
  }).sort((a, b) => b.created - a.created);
  res.json(list);
});

app.post('/api/projects', wrap(async (req, res) => {
  const id = new Date().toISOString().slice(0, 10) + '-' + crypto.randomUUID().slice(0, 6);
  const dir = pdir(id); fs.mkdirSync(dir, { recursive: true });
  const ext = String(req.query.ext || 'webm').replace(/[^a-z0-9]/gi, '').slice(0, 5);
  await pipeline(req, fs.createWriteStream(path.join(dir, 'raw.' + ext)));
  const p = { id, name: String(req.query.name || 'Screen recording').slice(0, 80), created: Date.now(), raw: 'raw.' + ext, status: 'uploaded', renders: [] };
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(p, null, 1));
  res.json({ id });
}));

app.get('/api/projects/:id', wrap(async (req, res) => {
  const p = loadP(req.params.id);
  res.json({ ...p, job: p.jobId ? jobs.get(p.jobId) || null : null, lines: p.transcript ? transcriptLines(p.transcript.words) : [] });
}));

app.delete('/api/projects/:id', wrap(async (req, res) => { fs.rmSync(pdir(req.params.id), { recursive: true, force: true }); res.json({ ok: true }); }));

app.put('/api/projects/:id/plan', wrap(async (req, res) => { const p = loadP(req.params.id); p.plan = req.body.plan; if (req.body.style) p.style = req.body.style; saveP(p); res.json({ ok: true }); }));

// Full pipeline: normalise → listen → look → understand → plan → find real media
app.post('/api/projects/:id/analyze', wrap(async (req, res) => {
  const cfg = loadConfig();
  const style = { ...cfg.style, ...(req.body.style || {}) };
  const job = startJob(req.params.id, 'analyze', async (ctx) => {
    let p = loadP(req.params.id); const dir = p._dir;
    p.style = style; p.status = 'analyzing'; saveP(p);
    const src = path.join(dir, 'source.mp4');
    if (!fs.existsSync(src)) {
      ctx.step('Preparing video');
      const info = await F.ingest(path.join(dir, p.raw), src);
      Object.assign(p, { duration: info.duration, width: info.width, height: info.height }); saveP(p);
    }
    ctx.progress(0.08);
    ctx.step('Listening: transcribing speech');
    p.transcript = await transcribe(cfg, src, dir, ctx.log);
    ctx.log(`${p.transcript.words.length} words transcribed`); saveP(p); ctx.progress(0.25);

    ctx.step('Listening: finding pauses');
    p.silences = await F.detectSilence(src); saveP(p);
    ctx.step('Watching: detecting scene changes');
    p.scenes = await F.detectScenes(src); saveP(p);
    ctx.step('Watching: sampling frames');
    Object.assign(p, await F.sampleFrames(src, dir, p.duration)); saveP(p); ctx.progress(0.35);

    ctx.step(`Understanding the video (${cfg.llm.provider})`);
    p.understanding = await understand(p, cfg, ctx.log); saveP(p);
    ctx.log('Understood: ' + (p.understanding.summary || '').slice(0, 200)); ctx.progress(0.6);

    await planAndSource(p, cfg, style, ctx);
  });
  res.json({ jobId: job.id });
}));

async function planAndSource(p, cfg, style, ctx, instruction) {
  ctx.step(instruction ? 'Revising the edit' : 'Planning the edit');
  const plan = instruction ? await revisePlan(p, cfg, style, p.plan, instruction, ctx.log) : await makePlan(p, cfg, style, ctx.log);
  ctx.log(`Plan: ${plan.cuts.length} cuts, ${plan.zooms.length} zooms, ${plan.broll.length} b-roll, ${plan.memes.length} memes, ${plan.sfx.length} sfx`);
  ctx.progress(0.8);
  ctx.step('Finding real b-roll, memes and sound effects online');
  await resolvePlanMedia(plan, cfg, ctx.log);
  carryManual(p.plan, plan, style.protectManual !== false);
  p.plan = plan; p.style = style; p.status = 'planned';
  if (instruction) (p.chat ||= []).push({ role: 'user', text: instruction }, { role: 'ai', text: plan.notes || 'Done.' });
  saveP(p);
}

app.post('/api/projects/:id/plan', wrap(async (req, res) => {
  const cfg = loadConfig();
  const p0 = loadP(req.params.id);
  if (!p0.understanding) return res.status(400).json({ error: 'Analyze the video first' });
  const style = { ...cfg.style, ...(p0.style || {}), ...(req.body.style || {}) };
  const job = startJob(p0.id, 'plan', async (ctx) => { const p = loadP(p0.id); await planAndSource(p, cfg, style, ctx); });
  res.json({ jobId: job.id });
}));

app.post('/api/projects/:id/revise', wrap(async (req, res) => {
  const cfg = loadConfig();
  const p0 = loadP(req.params.id);
  if (req.body.plan) { p0.plan = req.body.plan; saveP(p0); }
  const style = { ...cfg.style, ...(p0.style || {}) };
  const job = startJob(p0.id, 'revise', async (ctx) => { const p = loadP(p0.id); await planAndSource(p, cfg, style, ctx, String(req.body.instruction || '').slice(0, 2000)); });
  res.json({ jobId: job.id });
}));

app.post('/api/projects/:id/timeline', wrap(async (req, res) => {
  const p = loadP(req.params.id);
  res.json(buildTimeline(req.body.plan || p.plan, p));
}));

app.post('/api/projects/:id/render', wrap(async (req, res) => {
  const p0 = loadP(req.params.id);
  const plan = req.body.plan || p0.plan;
  p0.plan = plan; saveP(p0);
  const job = startJob(p0.id, 'render', async (ctx) => {
    const p = loadP(p0.id); const dir = p._dir;
    const tl = buildTimeline(plan, p);
    const n = (p.renders?.length || 0) + 1;
    const work = path.join(dir, 'render'); fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
    const media = path.join(dir, 'media');

    ctx.step('Downloading the real media');
    const assets = {};
    const byId = Object.fromEntries([...(plan.broll || []), ...(plan.memes || []), ...(plan.sfx || []), ...(plan.texts || [])].map((x) => [x.id, x]));
    const need = [...tl.overlays.map((o) => o.id), ...tl.sfx.map((s) => s.id)];
    for (const iid of need) {
      const it = byId[iid];
      const composed = req.body.memes?.[iid];
      try {
        if (composed) { const f = path.join(work, `meme_${iid}.png`); fs.writeFileSync(f, Buffer.from(composed.split(',')[1], 'base64')); assets[iid] = f; }
        else if (it.asset) { assets[iid] = await download(it.asset.url, media, it.asset); }
        else continue;
        ctx.log(`✓ ${it.query || it.template || it.text} (${it.asset?.provider || 'your text'})`);
      } catch (e) { ctx.log(`Could not get media for "${it.query || it.template || it.text}": ${e.message} — skipping`); }
    }
    if (tl.music) { try { assets.music = await download(plan.music.asset.url, media); } catch (e) { ctx.log('Music download failed, skipping: ' + e.message); } }
    ctx.progress(0.05);

    let captions = null;
    const caps = req.body.captions;
    if (caps?.frames?.length) {
      const cdir = path.join(work, 'caps'); fs.mkdirSync(cdir);
      fs.writeFileSync(path.join(cdir, 'blank.png'), Buffer.from(caps.blank.split(',')[1], 'base64'));
      const lines = ['ffconcat version 1.0'];
      let t = 0; const minD = 1 / F.FPS;
      caps.frames.sort((a, b) => a.s - b.s).forEach((fr, i) => {
        const name = `c_${String(i).padStart(5, '0')}.png`;
        fs.writeFileSync(path.join(cdir, name), Buffer.from(fr.data.split(',')[1], 'base64'));
        if (fr.s - t >= minD) { lines.push(`file 'blank.png'`, `duration ${(fr.s - t).toFixed(3)}`); t = fr.s; }
        const e = Math.max(fr.e, t + minD);
        lines.push(`file '${name}'`, `duration ${(e - t).toFixed(3)}`); t = e;
      });
      if (tl.total - t > minD) lines.push(`file 'blank.png'`, `duration ${(tl.total - t).toFixed(3)}`);
      lines.push(`file 'blank.png'`);
      fs.writeFileSync(path.join(cdir, 'list.txt'), lines.join('\n'));
      captions = { list: path.join(cdir, 'list.txt'), stripH: caps.stripH };
    }

    ctx.step('Rendering with ffmpeg');
    const outName = `edit_${n}.mp4`;
    await F.render({ src: path.join(dir, 'source.mp4'), workDir: work, tl, assets, captions, outFile: path.join(dir, outName), onProgress: (x) => ctx.progress(0.05 + x * 0.95), log: ctx.log });
    const p2 = loadP(p.id);
    (p2.renders ||= []).push({ file: outName, created: Date.now(), duration: tl.total });
    p2.status = 'rendered'; saveP(p2);
    ctx.log(`Done → ${outName} (${tl.total.toFixed(1)}s, from ${p.duration.toFixed(1)}s)`);
  });
  res.json({ jobId: job.id });
}));

// Your own file (image, video or sound) dropped into a project.
app.post('/api/projects/:id/media', wrap(async (req, res) => {
  const p = loadP(req.params.id);
  const ext = String(req.query.ext || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
  const kind = /^(png|jpe?g|gif|webp)$/.test(ext) ? 'image' : /^(mp3|wav|m4a|aac|ogg|flac)$/.test(ext) ? 'audio' : /^(mp4|mov|webm|m4v|mkv)$/.test(ext) ? 'video' : null;
  if (!kind) return res.status(400).json({ error: 'Use an image, video or sound file.' });
  const dir = path.join(p._dir, 'media'); fs.mkdirSync(dir, { recursive: true });
  const file = `upload_${crypto.randomUUID().slice(0, 8)}.${ext}`;
  await pipeline(req, fs.createWriteStream(path.join(dir, file)));
  const url = `/files/${p.id}/media/${file}`;
  res.json({ asset: { provider: 'Your file', kind, url, thumb: kind === 'image' ? url : null, title: String(req.query.name || file).slice(0, 80), credit: 'You', local: file } });
}));

// Storage used by projects, and opening the folder.
const dirSize = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? dirSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
app.get('/api/storage', wrap(async (req, res) => {
  const projects = fs.readdirSync(PROJECTS).filter((d) => fs.existsSync(path.join(PROJECTS, d, 'project.json'))).length;
  res.json({ path: PROJECTS, projects, bytes: dirSize(PROJECTS) });
}));
app.post('/api/storage/reveal', wrap(async (req, res) => {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  run(cmd, [PROJECTS]).catch(() => { });
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ media search & proxy
app.get('/api/search', wrap(async (req, res) => res.json(await search(req.query.type, req.query.q, loadConfig()))));

app.get('/api/proxy', wrap(async (req, res) => {
  const u = new URL(String(req.query.url));
  if (!/^https?:$/.test(u.protocol)) return res.status(400).end();
  const r = await fetch(u, { headers: { 'User-Agent': 'Rawcut/1.0 (local open-source video editor)' } });
  res.status(r.status).set('content-type', r.headers.get('content-type') || 'application/octet-stream').set('cache-control', 'max-age=86400');
  res.end(Buffer.from(await r.arrayBuffer()));
}));

/** Starts listening. If the port is taken, tries the next few. Resolves to the URL. */
export function start(port = PORT, tries = 10) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve(`http://localhost:${srv.address().port}`));
    srv.on('error', (e) => (e.code === 'EADDRINUSE' && tries > 0 && port ? start(port + 1, tries - 1).then(resolve, reject) : reject(e)));
  });
}

// `node server.js` / `npm start` / `npx rawcut`: start right away. The desktop app imports and calls start() itself.
if (!process.env.RAWCUT_EMBEDDED) {
  start().then((url) => {
    console.log(`\n  Rawcut is running →  ${url}\n`);
    if (process.argv.includes('--open')) {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      run(cmd, [url]).catch(() => { });
    }
  }, (e) => { console.error('Could not start Rawcut:', e.message); process.exit(1); });
}
