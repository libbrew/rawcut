// The editor's brain: first UNDERSTAND the footage, then PLAN restrained edits, then VALIDATE them in code
// so a model can never turn the video into a mess.
import path from 'node:path';
import crypto from 'node:crypto';
import { askJSON } from './llm.js';
import { imgflipTemplates } from './media.js';

const r2 = (x) => Math.round(x * 100) / 100;
const id = () => crypto.randomUUID().slice(0, 6);

export function transcriptLines(words) {
  const lines = []; let cur = [];
  const flush = () => { if (cur.length) lines.push({ s: cur[0].s, e: cur.at(-1).e, text: cur.map((w) => w.w).join(' ') }); cur = []; };
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (cur.length && (w.s - prev.e > 0.6 || cur.length >= 16 || (/[.!?]$/.test(prev.w) && cur.length >= 5))) flush();
    cur.push(w);
  });
  flush();
  return lines;
}
const fmtLines = (words) => transcriptLines(words).map((l) => `[${l.s.toFixed(2)}-${l.e.toFixed(2)}] ${l.text}`).join('\n') || '(no speech detected)';

function sheetsText(p) {
  return p.sheets.map((s, i) => `Image ${i + 1} (${s.file}): frames at ${s.times.map((t) => t.toFixed(1) + 's').join(', ')} — read left→right, top→bottom.`).join('\n');
}

// --------------------------------------------------------------------------------------------- understand
const UNDERSTAND_SYSTEM = `You are a senior video editor. Before you touch a single frame you watch the whole recording and build an accurate mental model of it: what it is, who it is for, what happens on screen and in the audio, where the important moments are, and where the dead weight is. You are precise with timestamps and you never invent things you did not see or hear.`;

export async function understand(p, cfg, log) {
  const dir = path.join(p._dir);
  const prompt = `Watch this recording and describe it. You have:
- Duration: ${p.duration.toFixed(2)}s, ${p.width}x${p.height}
- Contact sheets of sampled frames (attached images):
${sheetsText(p)}
- Visual scene changes (s): ${p.scenes.slice(0, 80).map((s) => s.t).join(', ') || 'none'}
- Silences (s): ${p.silences.slice(0, 120).map((s) => `${s.start}-${s.end}`).join(', ') || 'none'}
- Timestamped transcript:
${fmtLines(p.transcript.words)}

Return JSON exactly in this shape:
{
  "title": "short working title",
  "summary": "3-5 sentences: what this video is and what happens, in order",
  "video_type": "tutorial | product demo | coding | gameplay | talking head | presentation | vlog | other",
  "audience": "who would watch this",
  "tone": "e.g. casual and funny / calm and technical",
  "sections": [{"start": 0, "end": 0, "label": "short label", "on_screen": "what is visible", "said": "gist of what is said"}],
  "key_moments": [{"t": 0, "what": "a moment the viewer MUST see (a result, a reveal, an important click)"}],
  "screen_critical": [{"start": 0, "end": 0, "why": "on-screen content the viewer must be able to read/see; never cover it"}],
  "dead_air": [{"start": 0, "end": 0, "why": "waiting, loading, fumbling, retake, false start, off-topic"}],
  "humor_opportunities": [{"t": 0, "why": "genuinely funny/ironic/relatable beat and why"}],
  "visual_focus": [{"start": 0, "end": 0, "x": 0.5, "y": 0.5, "what": "where the action is on screen; x,y are 0-1 from top-left"}],
  "broll_opportunities": [{"start": 0, "end": 0, "concept": "a concrete thing being talked about that is NOT on screen"}]
}`;
  return askJSON(cfg, { system: UNDERSTAND_SYSTEM, prompt, images: p.sheets.map((s) => path.join(dir, s.file)), cwd: dir }, log);
}

// --------------------------------------------------------------------------------------------- plan
const DENSITY = { // per minute
  subtle: { broll: 1.5, memes: 0.4, sfx: 3, zooms: 2 },
  balanced: { broll: 3, memes: 1, sfx: 6, zooms: 3 },
  heavy: { broll: 6, memes: 2, sfx: 10, zooms: 5 },
};

const PLAN_SYSTEM = `You are a tasteful, experienced video editor. You make edits that serve the viewer and the story, never edits for their own sake. You only use REAL media found on the internet: stock footage, archive photos, well-known meme templates, real reaction GIFs, recorded sound effects. You never request AI-generated anything. When in doubt, you leave the original footage alone. A clean, restrained edit beats a busy one.`;

function planRules(style, dur, memeNames) {
  const d = DENSITY[style.intensity] || DENSITY.balanced;
  const mins = Math.max(dur / 60, 0.5);
  const cap = (k) => Math.max(1, Math.round(d[k] * mins));
  const off = (k) => style[k] === false;
  return `EDITING RULES
1. Story first. The edited video must still make complete sense. Never cut mid-sentence or mid-word. Never cut a key moment or screen-critical action.
2. CUTS: "cuts" lists ONLY ranges to DELETE (never list parts to keep). Remove dead air, long pauses, "um/uh" stalls, false starts and retakes (keep the BEST take, usually the last one: when someone says "wait, let me start again", cut the abandoned attempt AND that phrase, and keep the full restated sentence that follows), waiting for things to load, and off-topic rambling. Give exact source timestamps. ${style.removeSilence ? 'Pauses over ~0.8s are trimmed automatically, so focus on content cuts.' : 'Do not trim natural pauses; only cut content that should go.'}
3. ZOOMS${off('zooms') ? ' (DISABLED: return [])' : ''}: punch in when the viewer needs to see a small detail on screen (a button being clicked, a line of code, a number). Use visual_focus coordinates. scale 1.2-1.6, at least 1.5s long, max ${cap('zooms')} total. Never zoom on a talking face for no reason.
4. B-ROLL${off('broll') ? ' (DISABLED: return [])' : ''}: only when the speaker talks about something concrete that is NOT already visible. Never during screen_critical ranges or key moments (use "pip" mode there if you must). Queries must be concrete, visual, stock-footage style search terms of 2-4 words (e.g. "server room racks", "stock market chart", "rocket launch", "person typing laptop") — not abstract ideas. kind "video" for motion footage, "image" for a specific real person/place/product/historical thing (archive photo). 2-5s each, max ${cap('broll')} total, never overlapping.
5. MEMES${off('memes') ? ' (DISABLED: return [])' : ''}: only at a genuinely funny, ironic or relatable beat (see humor_opportunities). Real, recognisable memes only. kind "template" = a classic meme image with short top/bottom text that riffs on what was just said (template must be an EXACT name from the list below); kind "gif" = a real reaction GIF (query like "mind blown", "this is fine", "facepalm"). 1.5-3s, max ${cap('memes')} total. If nothing is actually funny, return []. A forced meme is worse than none.
6. SFX${off('sfx') ? ' (DISABLED: return [])' : ''}: subtle real sound effects that support an edit: "whoosh" when b-roll comes in, "pop" when a meme appears, "click" for an important click, "ding" for a success/reveal, "record scratch" for an awkward beat. volume 0.2-0.7. max ${cap('sfx')} total, never two within 1s.
7. MUSIC: ${style.music ? 'suggest one background music search query matching the tone (e.g. "lofi chill beat", "upbeat corporate"), volume 0.05-0.1.' : 'set "music" to null.'}
8. Every item needs a short "reason" a human editor would agree with.
${style.notes ? `\nTHE CREATOR'S OWN INSTRUCTIONS (follow them): ${style.notes}\n` : ''}
Meme templates you may use (exact names): ${memeNames.join(' | ')}`;
}

const PLAN_SHAPE = `Return JSON exactly in this shape (all times are SOURCE seconds):
{
  "cuts":  [{"start": 0, "end": 0, "reason": ""}],
  "zooms": [{"start": 0, "end": 0, "x": 0.5, "y": 0.5, "scale": 1.3, "reason": ""}],
  "broll": [{"start": 0, "end": 0, "query": "", "kind": "video|image", "mode": "full|pip", "reason": ""}],
  "memes": [{"start": 0, "end": 0, "kind": "template|gif", "template": "exact template name or empty", "top_text": "", "bottom_text": "", "query": "gif search or empty", "position": "center|top-right|top-left|bottom-right|bottom-left", "reason": ""}],
  "sfx":   [{"t": 0, "query": "", "volume": 0.5, "reason": ""}],
  "music": {"query": "", "volume": 0.07} or null,
  "notes": "one or two sentences: your editing approach for this video"
}`;

async function memeNames() {
  try { return (await imgflipTemplates()).slice(0, 100).map((m) => m.name); } catch { return ['Drake Hotline Bling', 'Distracted Boyfriend', 'Two Buttons', 'Change My Mind', 'Expanding Brain', 'This Is Fine']; }
}

function context(p) {
  return `VIDEO: ${p.duration.toFixed(2)}s, ${p.width}x${p.height}

WHAT YOU UNDERSTOOD WHEN WATCHING IT:
${JSON.stringify(p.understanding, null, 1)}

SILENCES (s): ${p.silences.slice(0, 150).map((s) => `${s.start}-${s.end}`).join(', ') || 'none'}

TRANSCRIPT:
${fmtLines(p.transcript.words)}`;
}

export async function makePlan(p, cfg, style, log) {
  const prompt = `${context(p)}

${planRules(style, p.duration, await memeNames())}

${PLAN_SHAPE}`;
  const plan = await askJSON(cfg, { system: PLAN_SYSTEM, prompt, cwd: p._dir }, log);
  return validatePlan(plan, p, style);
}

/**
 * Things the AI never sees or must not undo: your text titles, split points, and (when
 * "Protect my edits" is on) every item you changed by hand. Copied from the old plan into the new one.
 */
export function carryManual(oldPlan, next, protect = true) {
  if (!oldPlan) return next;
  next.texts = oldPlan.texts || [];
  next.splits = oldPlan.splits || [];
  if (!protect) return next;
  for (const k of ['cuts', 'zooms', 'broll', 'memes', 'sfx']) {
    const mine = (oldPlan[k] || []).filter((x) => x.manual);
    if (!mine.length) continue;
    const ids = new Set(mine.map((x) => x.id));
    next[k] = [...(next[k] || []).filter((x) => !ids.has(x.id)), ...mine];
  }
  return next;
}

export async function revisePlan(p, cfg, style, current, instruction, log) {
  const slim = JSON.parse(JSON.stringify(current, (k, v) => (k === 'candidates' || k === 'asset' ? undefined : v)));
  const prompt = `${context(p)}

${planRules(style, p.duration, await memeNames())}

CURRENT EDIT PLAN:
${JSON.stringify(slim, null, 1)}

THE CREATOR ASKS: "${instruction}"

Apply exactly what they asked (and nothing else). Keep the "id" field of every item you leave unchanged so its chosen media is kept. New items get no id.
${PLAN_SHAPE}`;
  const next = await askJSON(cfg, { system: PLAN_SYSTEM, prompt, cwd: p._dir }, log);
  // carry over chosen media for items that kept their id and query
  for (const k of ['broll', 'memes', 'sfx']) {
    const old = new Map((current[k] || []).map((x) => [x.id, x]));
    for (const it of next[k] || []) {
      const o = it.id && old.get(it.id);
      if (o && (o.query || '') === (it.query || '') && (o.template || '') === (it.template || '')) { it.candidates = o.candidates; it.asset = o.asset; }
    }
  }
  if (next.music && current.music && next.music.query === current.music.query) { next.music.asset = current.music.asset; next.music.candidates = current.music.candidates; }
  return validatePlan(next, p, style);
}

// --------------------------------------------------------------------------------------------- validate
const overlaps = (a, b, pad = 0) => a.start < b.end + pad && b.start < a.end + pad;

function mergeRanges(rs) {
  const s = rs.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of s) { const l = out.at(-1); if (l && r.start <= l.end + 0.05) { l.end = Math.max(l.end, r.end); if (r.reason && !l.reason.includes(r.reason)) l.reason += '; ' + r.reason; } else out.push({ ...r }); }
  return out;
}

function subtract(r, blocks) { // r minus list of blocks
  let parts = [r];
  for (const b of blocks) parts = parts.flatMap((p) => (!overlaps(p, b) ? [p] : [
    ...(b.start > p.start ? [{ ...p, end: b.start }] : []),
    ...(b.end < p.end ? [{ ...p, start: b.end }] : []),
  ]));
  return parts;
}

export function validatePlan(plan, p, style) {
  const D = p.duration;
  const words = p.transcript.words || [];
  const U = p.understanding || {};
  // a "critical" range spanning most of the video is not a real priority signal; ignore it
  const crit = (U.screen_critical || []).map((c) => ({ start: +c.start, end: +c.end })).filter((c) => c.end - c.start <= D * 0.4);
  const keyM = (U.key_moments || []).map((k) => ({ start: +k.t - 0.75, end: +k.t + 0.75 }));
  const protect = [...crit, ...keyM];
  const clampR = (o) => { o.start = r2(Math.max(0, Math.min(D, +o.start || 0))); o.end = r2(Math.max(0, Math.min(D, +o.end || 0))); return o; };
  const d = DENSITY[style.intensity] || DENSITY.balanced;
  const capFor = (k) => Math.max(1, Math.round(d[k] * Math.max(D / 60, 0.5)));
  const out = { notes: String(plan.notes || ''), cuts: [], zooms: [], broll: [], memes: [], sfx: [], music: null };

  // ---- cuts: model's content cuts + automatic silence trimming, snapped to word boundaries
  let cuts = (plan.cuts || []).map((c) => clampR({ id: c.id || id(), start: c.start, end: c.end, reason: String(c.reason || 'cut'), auto: !!c.auto, enabled: c.enabled !== false }));
  cuts = cuts.filter((c) => !c.auto && !/^\s*(keep|no cut|don'?t cut|leave)/i.test(c.reason));
  // guard: content cuts may not delete most of what was said. Drop the biggest cuts until <=40% of words are gone.
  const wordsIn = (c) => words.filter((w) => w.s >= c.start - 0.01 && w.e <= c.end + 0.01).length;
  if (words.length) {
    const lim = Math.ceil(words.length * 0.4);
    const byBig = [...cuts].sort((a, b) => wordsIn(b) - wordsIn(a));
    while (byBig.length && cuts.reduce((a, c) => a + wordsIn(c), 0) > lim) { const big = byBig.shift(); cuts = cuts.filter((c) => c !== big); }
  }
  if (style.removeSilence) {
    const pad = 0.22;
    for (const s of p.silences || []) {
      const st = s.start === 0 ? 0 : s.start + pad, en = s.end >= D - 0.05 ? D : s.end - pad;
      if (en - st >= 0.5) {
        // never trim silence inside protected screen moments (loading spinners the viewer needs, etc.)
        for (const part of subtract({ start: st, end: en }, crit)) if (part.end - part.start >= 0.5) cuts.push({ id: id(), start: r2(part.start), end: r2(part.end), reason: 'pause', auto: true, enabled: true });
      }
    }
  }
  for (const c of cuts) {
    if (c.auto) continue; // pauses come from measured audio silence; padding already protects word edges
    for (const w of words) {
      if (w.s < c.start && w.e > c.start) c.start = r2(w.e + 0.04); // word straddles cut start → keep the whole word
      if (w.s < c.end && w.e > c.end) c.end = r2(w.s - 0.04);
    }
  }
  cuts = cuts.filter((c) => c.end - c.start >= 0.25);
  const enabled = mergeRanges(cuts.filter((c) => c.enabled && !c.auto).map((c) => ({ ...c })));
  const autos = cuts.filter((c) => c.auto);
  // safety: never remove more than 70% of the video
  let removed = enabled.reduce((a, c) => a + c.end - c.start, 0) + autos.reduce((a, c) => a + c.end - c.start, 0);
  if (removed > D * 0.7) { autos.length = 0; }
  out.cuts = [...cuts.filter((c) => !c.auto || autos.includes(c))].sort((a, b) => a.start - b.start);

  // ---- overlays
  const noOverlap = (list) => { const res = []; for (const it of list.sort((a, b) => a.start - b.start)) if (!res.some((r) => overlaps(r, it, 0.3))) res.push(it); return res; };
  const fitDur = (o, min, max) => { if (o.end - o.start < min) o.end = r2(Math.min(D, o.start + min)); if (o.end - o.start > max) o.end = r2(o.start + max); return o; };

  if (style.zooms !== false) {
    out.zooms = noOverlap((plan.zooms || []).map((z) => fitDur(clampR({ id: z.id || id(), start: z.start, end: z.end, x: Math.min(0.95, Math.max(0.05, +z.x || 0.5)), y: Math.min(0.95, Math.max(0.05, +z.y || 0.5)), scale: Math.min(1.8, Math.max(1.1, +z.scale || 1.3)), reason: String(z.reason || ''), enabled: z.enabled !== false }), 1.5, 8))).slice(0, capFor('zooms') + 2);
  }

  if (style.broll !== false) {
    out.broll = noOverlap((plan.broll || []).filter((b) => b.query).map((b) => {
      const o = fitDur(clampR({ ...b, id: b.id || id(), query: String(b.query).slice(0, 60), kind: b.kind === 'image' ? 'image' : 'video', mode: b.mode === 'pip' ? 'pip' : 'full', reason: String(b.reason || ''), enabled: b.enabled !== false }), 1.5, 6);
      if (o.mode === 'full' && protect.some((pr) => overlaps(pr, o))) o.mode = 'pip'; // don't hide what matters
      return o;
    })).slice(0, capFor('broll'));
  }

  if (style.memes !== false) {
    out.memes = noOverlap((plan.memes || []).filter((m) => m.template || m.query).map((m) => {
      const o = fitDur(clampR({ ...m, id: m.id || id(), kind: m.kind === 'gif' ? 'gif' : 'template', template: String(m.template || ''), query: String(m.query || m.template || ''), top_text: String(m.top_text || '').slice(0, 80), bottom_text: String(m.bottom_text || '').slice(0, 80), position: m.position || 'center', reason: String(m.reason || ''), enabled: m.enabled !== false }), 1.2, 3.5);
      if (o.position === 'center' && protect.some((pr) => overlaps(pr, o))) o.position = 'bottom-right';
      return o;
    }).filter((m) => !out.broll.some((b) => overlaps(b, m)))).slice(0, capFor('memes'));
  }

  if (style.sfx !== false) {
    const list = (plan.sfx || []).filter((s) => s.query).map((s) => ({ ...s, id: s.id || id(), t: r2(Math.max(0, Math.min(D, +s.t || 0))), query: String(s.query).slice(0, 40), volume: Math.min(0.8, Math.max(0.1, +s.volume || 0.5)), reason: String(s.reason || ''), enabled: s.enabled !== false })).sort((a, b) => a.t - b.t);
    for (const s of list) if (!out.sfx.some((x) => Math.abs(x.t - s.t) < 1)) out.sfx.push(s);
    out.sfx = out.sfx.slice(0, capFor('sfx'));
  }

  if (style.music && plan.music && plan.music.query) out.music = { ...plan.music, query: String(plan.music.query).slice(0, 50), volume: Math.min(0.15, Math.max(0.03, +plan.music.volume || 0.07)), enabled: plan.music.enabled !== false };
  return out;
}

// --------------------------------------------------------------------------------------------- timeline
/** Turn a plan in source time into concrete output-time render instructions. */
export function buildTimeline(plan, p) {
  const D = p.duration;
  const cuts = mergeRanges((plan.cuts || []).filter((c) => c.enabled !== false).map((c) => ({ start: c.start, end: c.end, reason: '' })));
  const keep = [];
  let t = 0;
  for (const c of cuts) { if (c.start - t > 0.08) keep.push({ s: r2(t), e: r2(c.start) }); t = Math.max(t, c.end); }
  if (D - t > 0.08) keep.push({ s: r2(t), e: r2(D) });
  if (!keep.length) keep.push({ s: 0, e: r2(D) });
  const offs = []; let acc = 0; for (const k of keep) { offs.push(acc); acc += k.e - k.s; }
  const total = acc;
  const mapT = (x, dir = 1) => { // dir=1 snap forward out of cuts, -1 snap back
    for (let i = 0; i < keep.length; i++) {
      const k = keep[i];
      if (x >= k.s && x <= k.e) return offs[i] + (x - k.s);
      if (x < k.s) return dir > 0 ? offs[i] : (i ? offs[i - 1] + (keep[i - 1].e - keep[i - 1].s) : 0);
    }
    return total;
  };
  const mapR = (o) => { const s = mapT(o.start, 1), e = mapT(o.end, -1); return e - s >= 0.5 ? { s: r2(s), e: r2(e) } : null; };

  const on = (x) => x.enabled !== false;
  const zooms = (plan.zooms || []).filter(on).map((z) => { const m = mapR(z); return m && { ...m, x: z.x, y: z.y, scale: z.scale }; }).filter(Boolean);
  const overlays = [];
  const look = (o) => ({ size: o.size, fade: o.fade, position: o.position });
  for (const b of (plan.broll || []).filter(on)) { const m = mapR(b); if (m && b.asset) overlays.push({ id: b.id, type: 'broll', mode: b.mode, mediaKind: b.asset.kind, label: b.query, ...look(b), ...m }); }
  for (const mm of (plan.memes || []).filter(on)) { const m = mapR(mm); if (m && mm.asset) overlays.push({ id: mm.id, type: 'meme', mediaKind: mm.asset.kind, label: mm.template || mm.query, ...look(mm), ...m }); }
  // Text titles you add yourself. The browser draws them as transparent full-frame PNGs.
  for (const tx of (plan.texts || []).filter(on)) { const m = mapR(tx); if (m && tx.text) overlays.push({ id: tx.id, type: 'text', mediaKind: 'image', label: tx.text, fade: tx.fade, ...m }); }
  overlays.sort((a, b) => a.s - b.s);
  const sfx = (plan.sfx || []).filter((s) => on(s) && s.asset).map((s) => { const inCut = cuts.some((c) => s.t > c.start && s.t < c.end); return inCut ? null : { id: s.id, t: r2(mapT(s.t)), volume: s.volume }; }).filter(Boolean);

  // captions in output time
  const words = (p.transcript.words || []).filter((w) => !cuts.some((c) => w.s >= c.start - 0.01 && w.e <= c.end + 0.01)).map((w) => ({ w: w.w, s: r2(mapT(w.s)), e: r2(mapT(w.e, -1)) }));
  const chunks = []; let cur = [];
  const flush = () => { if (cur.length) chunks.push({ start: cur[0].s, end: cur.at(-1).e, words: cur }); cur = []; };
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (cur.length && (cur.length >= 3 || w.s - prev.e > 0.45 || /[.!?,]$/.test(prev.w))) flush();
    cur.push(w);
  });
  flush();
  chunks.forEach((c, i) => { const next = chunks[i + 1]; c.end = r2(Math.min(next ? next.start : total, c.end + 0.35)); });

  const W = p.width, H = p.height;
  return { W, H, total: r2(total), keep, zooms, overlays, sfx, music: plan.music && on(plan.music) && plan.music.asset ? { volume: plan.music.volume } : null, captions: chunks };
}
