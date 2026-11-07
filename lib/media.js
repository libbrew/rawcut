// Real media only: stock footage, archive photos/video, real meme templates, real reaction GIFs, recorded sound effects.
// Nothing here generates media.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const UA = 'Rawcut/1.0 (local open-source video editor)';
const enc = encodeURIComponent;

async function j(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}

// ---------- B-roll video ----------
async function pexels(q, key) {
  const d = await j(`https://api.pexels.com/videos/search?query=${enc(q)}&per_page=6&orientation=landscape`, { headers: { Authorization: key } });
  return (d.videos || []).map((v) => {
    const files = v.video_files.filter((f) => f.file_type === 'video/mp4' && f.width).sort((a, b) => a.width - b.width);
    const f = files.find((x) => x.width >= 1280) || files.at(-1);
    return f && { provider: 'Pexels', kind: 'video', url: f.link, thumb: v.image, title: v.url.split('/').filter(Boolean).pop().replace(/-\d+$/, '').replace(/-/g, ' '), credit: v.user?.name, page: v.url, duration: v.duration };
  }).filter(Boolean);
}

async function pixabay(q, key) {
  const d = await j(`https://pixabay.com/api/videos/?key=${key}&q=${enc(q)}&per_page=6&safesearch=true`);
  return (d.hits || []).map((h) => {
    const v = h.videos.medium?.url ? h.videos.medium : h.videos.small;
    return { provider: 'Pixabay', kind: 'video', url: v.url, thumb: v.thumbnail || h.videos.tiny?.thumbnail, title: h.tags, credit: h.user, page: h.pageURL, duration: h.duration };
  });
}

async function wikimedia(q, kind) {
  const ft = kind === 'video' ? 'filetype:video' : 'filetype:bitmap';
  const d = await j(`https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=${enc(q + ' ' + ft)}&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=1280&origin=*`);
  const toks = norm(q).filter((t) => t.length > 2);
  return Object.values(d.query?.pages || {}).sort((a, b) => a.index - b.index)
    .filter((p) => !toks.length || toks.some((t) => p.title.toLowerCase().includes(t))) // Commons full-text search is loose; keep only on-topic titles
    .map((p) => {
    const ii = p.imageinfo?.[0]; if (!ii) return null;
    const isVid = /^video\//.test(ii.mime);
    if ((kind === 'video') !== isVid) return null;
    if (!isVid && !/jpeg|png|webp/.test(ii.mime)) return null;
    return { provider: 'Wikimedia Commons', kind: isVid ? 'video' : 'image', url: isVid ? ii.url : (ii.thumburl || ii.url), thumb: ii.thumburl, title: p.title.replace(/^File:/, '').replace(/\.\w+$/, ''), credit: 'Wikimedia Commons', page: ii.descriptionurl };
  }).filter(Boolean);
}

// Openverse matches loosely ("terminal window typing" can return a photo of a ring), so keep only
// results whose title or tags actually mention the query, best matches first.
const STOP = new Set(['a', 'an', 'the', 'of', 'on', 'in', 'at', 'and', 'or', 'with', 'to', 'for', 'is', 'up', 'shot', 'close', 'closeup', 'view', 'footage', 'video', 'stock']);
const keyTokens = (q) => String(q).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));
function relevance(q, text) {
  const hay = String(text).toLowerCase();
  return keyTokens(q).filter((t) => hay.includes(t.replace(/(ing|es|s)$/, ''))).length;
}
async function openverseImages(q) {
  const d = await j(`https://api.openverse.org/v1/images/?q=${enc(q)}&page_size=20&mature=false&aspect_ratio=wide`);
  const need = Math.min(2, keyTokens(q).length);
  return (d.results || []).map((r) => ({ r, score: relevance(q, `${r.title} ${(r.tags || []).map((t) => t.name).join(' ')}`) }))
    .filter((x) => x.score >= need).sort((a, b) => b.score - a.score).slice(0, 8).map(({ r }) => ({ provider: 'Openverse', kind: 'image', url: r.url, thumb: r.thumbnail || r.url, title: r.title, credit: `${r.creator || 'unknown'} (${(r.license || '').toUpperCase()})`, page: r.foreign_landing_url }));
}

// ---------- Memes ----------
let imgflipCache = null;
export async function imgflipTemplates() {
  if (imgflipCache) return imgflipCache;
  const d = await j('https://api.imgflip.com/get_memes');
  imgflipCache = d.data.memes;
  return imgflipCache;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
async function imgflip(q) {
  const list = await imgflipTemplates();
  const qt = norm(q), qs = qt.join(' ');
  const scored = list.map((m) => {
    const nt = norm(m.name), ns = nt.join(' ');
    let s = ns === qs ? 100 : 0;
    if (ns.includes(qs) || qs.includes(ns)) s += 20;
    s += qt.filter((t) => nt.includes(t)).length * 5;
    return { m, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 8);
  return scored.map(({ m }) => ({ provider: 'Imgflip', kind: 'image', url: m.url, thumb: m.url, title: m.name, credit: 'Imgflip template', page: `https://imgflip.com/meme/${m.id}`, template: true }));
}

async function giphy(q, key) {
  const d = await j(`https://api.giphy.com/v1/gifs/search?api_key=${key}&q=${enc(q)}&limit=8&rating=pg-13`);
  return (d.data || []).map((g) => ({ provider: 'GIPHY', kind: 'video', url: g.images.original.mp4 || g.images.fixed_height.mp4, thumb: g.images.fixed_width.url, title: g.title, credit: g.username || 'GIPHY', page: g.url }));
}

// ---------- Sound ----------
async function freesound(q, key, music = false) {
  const filter = music ? 'duration:[20 TO 300]' : 'duration:[0.05 TO 5]';
  const d = await j(`https://freesound.org/apiv2/search/text/?query=${enc(q)}&token=${key}&fields=id,name,previews,duration,username,url&filter=${enc(filter)}&page_size=8&sort=score`);
  return (d.results || []).map((r) => ({ provider: 'Freesound', kind: 'audio', url: r.previews['preview-hq-mp3'], thumb: null, title: r.name, credit: r.username, page: r.url, duration: r.duration }));
}

async function openverseAudio(q, music = false) {
  const d = await j(`https://api.openverse.org/v1/audio/?q=${enc(music ? q + ' music' : q)}&page_size=20&mature=false`);
  return (d.results || []).filter((r) => r.url && (music ? (!r.duration || r.duration > 20000) : (!r.duration || r.duration < 8000)))
    .map((r) => ({ provider: 'Openverse', kind: 'audio', url: r.url, thumb: null, title: r.title, credit: `${r.creator || 'unknown'} (${(r.license || '').toUpperCase()})`, page: r.foreign_landing_url, duration: r.duration ? r.duration / 1000 : null }));
}

async function gather(fns) {
  const res = await Promise.allSettled(fns.map((f) => f()));
  const out = [], seen = new Set();
  for (const r of res) if (r.status === 'fulfilled') for (const c of r.value) if (c && !seen.has(c.url)) { seen.add(c.url); out.push(c); }
  return out;
}

const RANK = { Pexels: 0, Pixabay: 1, Openverse: 2, 'Wikimedia Commons': 3 };
const rank = (c) => (RANK[c.provider] ?? 5) + (c.kind === 'video' && c.provider === 'Wikimedia Commons' ? -1.5 : 0);

/** type: broll | broll-image | meme | gif | sfx | music */
export async function search(type, q, cfg) {
  const M = cfg.media;
  q = String(q || '').trim(); if (!q) return [];
  switch (type) {
    case 'broll': return (await gather([
      M.pexels && (() => pexels(q, M.pexels)),
      M.pixabay && (() => pixabay(q, M.pixabay)),
      () => wikimedia(q, 'video'),
      () => openverseImages(q),
      () => wikimedia(q, 'image'),
    ].filter(Boolean))).sort((a, b) => rank(a) - rank(b)).slice(0, 16);
    case 'broll-image': return gather([() => openverseImages(q), () => wikimedia(q, 'image')]);
    case 'meme': return gather([() => imgflip(q)]);
    case 'gif': return M.giphy ? gather([() => giphy(q, M.giphy)]) : gather([() => imgflip(q)]);
    case 'sfx': return gather([M.freesound && (() => freesound(q, M.freesound)), () => openverseAudio(q)].filter(Boolean));
    case 'music': return gather([M.freesound && (() => freesound(q, M.freesound, true)), () => openverseAudio(q, true)].filter(Boolean));
    default: return [];
  }
}

export function searchTypeFor(kind, item) {
  if (kind === 'broll') return item.kind === 'image' ? 'broll-image' : 'broll';
  if (kind === 'memes') return item.kind === 'gif' ? 'gif' : 'meme';
  return kind; // sfx
}

async function pool(items, n, fn) {
  const q = [...items]; const workers = Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); });
  await Promise.all(workers);
}

/** Fill candidates + chosen asset for any plan item that doesn't have them yet. */
export async function resolvePlanMedia(plan, cfg, log = () => {}) {
  const jobs = [];
  for (const kind of ['broll', 'memes', 'sfx']) for (const it of plan[kind] || []) if (!it.asset) jobs.push([kind, it]);
  if (plan.music && plan.music.query && !plan.music.asset) jobs.push(['music', plan.music]);
  await pool(jobs, 4, async ([kind, it]) => {
    const type = kind === 'music' ? 'music' : searchTypeFor(kind, it);
    const q = (kind === 'memes' && it.kind !== 'gif') ? (it.template || it.query) : it.query;
    let c = await search(type, q, cfg).catch(() => []);
    if (!c.length && q && q.split(' ').length > 2) c = await search(type, q.split(' ').slice(0, 2).join(' '), cfg).catch(() => []);
    if (!c.length && kind === 'memes' && it.kind === 'gif') c = await search('meme', it.query, cfg).catch(() => []);
    it.candidates = c.slice(0, 12);
    it.asset = c[0] || null;
    log(`${kind === 'memes' ? 'meme' : kind} "${q}" → ${it.asset ? `${it.asset.provider}: ${it.asset.title}` : 'nothing found'}`);
  });
  return plan;
}

const EXT = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/ogg': '.ogv', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/flac': '.flac' };

export async function download(url, dir, asset) {
  fs.mkdirSync(dir, { recursive: true });
  if (asset?.local) { const f = path.join(dir, path.basename(asset.local)); if (fs.existsSync(f)) return f; throw new Error('your uploaded file is missing'); }
  const h = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const existing = fs.readdirSync(dir).find((f) => f.startsWith(h + '.'));
  if (existing) return path.join(dir, existing);
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120000), redirect: 'follow' });
  if (!r.ok) throw new Error(`download ${r.status}`);
  const ct = (r.headers.get('content-type') || '').split(';')[0];
  const ext = EXT[ct] || path.extname(new URL(url).pathname).slice(0, 6) || '.bin';
  const file = path.join(dir, h + ext);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}
