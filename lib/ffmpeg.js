import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const FPS = 30;
const IS_WIN = process.platform === 'win32';

export function run(cmd, args, { cwd, input, timeout = 0, onStderr, env, binary } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    // On Windows, CLIs installed by npm are .cmd shims and need a shell.
    const useShell = IS_WIN && !/[\\/]/.test(cmd) && cmd !== 'sh';
    try { child = spawn(cmd, useShell ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args, { cwd, env: { ...process.env, ...(env || {}) }, shell: useShell, windowsHide: true }); }
    catch (e) { return reject(e); }
    let stdout = '', stderr = ''; const chunks = [];
    let timer = timeout ? setTimeout(() => { child.kill('SIGKILL'); }, timeout) : null;
    child.stdout.on('data', (d) => { if (binary) chunks.push(d); else stdout += d; });
    child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; if (stderr.length > 2e6) stderr = stderr.slice(-1e6); onStderr?.(s); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout: binary ? Buffer.concat(chunks) : stdout, stderr }); });
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); } else child.stdin.end();
  });
}

/** Is a command on PATH? Works on macOS, Linux and Windows. */
export function which(cmd) {
  const r = IS_WIN ? spawnSync('where', [cmd], { windowsHide: true }) : spawnSync('sh', ['-c', `command -v "${cmd}"`]);
  return r.status === 0 ? String(r.stdout).split(/\r?\n/)[0].trim() : null;
}

// ffmpeg: use the user's own install if they have one, otherwise the copy bundled with Rawcut.
function bundledFfmpeg() {
  try {
    let p = createRequire(import.meta.url)('ffmpeg-static');
    if (p) p = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep); // inside the desktop app
    return p && fs.existsSync(p) ? p : null;
  } catch { return null; }
}
function pickFfmpeg() {
  if (process.env.RAWCUT_FFMPEG) return process.env.RAWCUT_FFMPEG;
  const sys = which('ffmpeg');
  if (sys) {
    const r = spawnSync(sys, ['-hide_banner', '-filters'], { windowsHide: true });
    if (r.status === 0 && /zoompan/.test(r.stdout) && /scdet/.test(r.stdout)) return sys;
  }
  return bundledFfmpeg() || 'ffmpeg';
}
export const FFMPEG = pickFfmpeg();
const FF_MAJOR = +((String(spawnSync(FFMPEG, ['-version'], { windowsHide: true }).stdout || '').match(/version n?(\d+)/) || [])[1] || 0);
/** ffmpeg 7+ reads a filter graph from a file with -/filter_complex; older versions use -filter_complex_script. */
export const scriptFlag = () => (FF_MAJOR >= 7 ? '-/filter_complex' : '-filter_complex_script');
export const ffmpegInfo = () => ({ path: FFMPEG, version: FF_MAJOR, bundled: FFMPEG === bundledFfmpeg() });

export async function ff(args, opts = {}) {
  const r = await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args], opts);
  if (r.code !== 0) throw new Error('ffmpeg failed: ' + r.stderr.split('\n').filter(Boolean).slice(-8).join(' | '));
  return r;
}

/** Media info from ffmpeg's own banner, so no separate ffprobe binary is needed. */
export async function probe(file) {
  const r = await run(FFMPEG, ['-hide_banner', '-nostdin', '-i', file]);
  const s = r.stderr;
  if (!/Input #0/.test(s)) throw new Error('Could not read media file: ' + s.split('\n').filter(Boolean).slice(-2).join(' '));
  const dm = s.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const v = s.match(/Stream #\S+.*Video: .*?\b(\d{2,5})x(\d{2,5})\b/);
  return {
    duration: dm ? +dm[1] * 3600 + +dm[2] * 60 + +dm[3] : 0,
    width: v ? +v[1] : 0,
    height: v ? +v[2] : 0,
    hasVideo: !!v,
    hasAudio: /Stream #\S+.*Audio:/.test(s),
    audioCount: (s.match(/Stream #\S+.*Audio:/g) || []).length,
  };
}

/** Normalise any recording (VFR webm/mp4 from MediaRecorder) into a CFR H.264 mp4 that always has stereo audio. */
export async function ingest(input, out) {
  const info = await probe(input);
  const vf = `fps=${FPS},scale='trunc(min(1920,iw)/2)*2':-2,setsar=1,format=yuv420p`;
  const args = ['-i', input];
  if (!info.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  // Native Mac recordings store system audio and the microphone as separate tracks: mix them.
  let amap = info.hasAudio ? '0:a:0' : '1:a:0';
  if (info.audioCount > 1) {
    const ins = Array.from({ length: info.audioCount }, (_, i) => `[0:a:${i}]`).join('');
    args.push('-filter_complex', `${ins}amix=inputs=${info.audioCount}:duration=longest:normalize=0,alimiter=limit=0.95[am]`);
    amap = '[am]';
  }
  args.push('-map', '0:v:0', '-map', amap, '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', String(FPS * 2),
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out);
  await ff(args);
  return probe(out);
}

export const extractWav = (src, out) => ff(['-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out]);
export const extractMp3 = (src, out) => ff(['-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', out]);

export async function detectSilence(src, noise = '-38dB', d = 0.5) {
  const r = await ff(['-i', src, '-vn', '-af', `silencedetect=noise=${noise}:d=${d}`, '-f', 'null', '-']);
  const out = []; let start = null;
  for (const line of r.stderr.split('\n')) {
    let m = line.match(/silence_start: (-?[\d.]+)/); if (m) start = Math.max(0, parseFloat(m[1]));
    m = line.match(/silence_end: ([\d.]+)/); if (m && start != null) { out.push({ start: +start.toFixed(2), end: +parseFloat(m[1]).toFixed(2) }); start = null; }
  }
  return out;
}

export async function detectScenes(src) {
  const r = await ff(['-i', src, '-an', '-vf', 'scale=320:-2,scdet=threshold=10', '-f', 'null', '-']);
  const out = [];
  for (const m of r.stderr.matchAll(/lavfi\.scd\.score: ([\d.]+), lavfi\.scd\.time: ([\d.]+)/g)) out.push({ t: +parseFloat(m[2]).toFixed(2), score: +parseFloat(m[1]).toFixed(1) });
  return out;
}

/** Sample frames across the video and pack them into labelled-by-order contact sheets for the LLM to look at. */
export async function sampleFrames(src, dir, duration) {
  const fdir = path.join(dir, 'frames');
  fs.rmSync(fdir, { recursive: true, force: true });
  fs.mkdirSync(fdir, { recursive: true });
  const interval = Math.max(2, duration / 36);
  const times = [];
  for (let t = Math.min(interval / 2, duration / 2); t < duration - 0.05; t += interval) times.push(+t.toFixed(2));
  if (!times.length) times.push(0);
  const frames = [];
  for (let i = 0; i < times.length; i++) {
    const file = `frames/f_${String(i + 1).padStart(3, '0')}.jpg`;
    await ff(['-ss', String(times[i]), '-i', src, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', path.join(dir, file)]);
    frames.push({ t: times[i], file });
  }
  // contact sheets: 3x2 frames each, reading order left->right, top->bottom
  await ff(['-framerate', '1', '-i', path.join(fdir, 'f_%03d.jpg'), '-vf', 'scale=480:-2,tile=3x2:padding=6:margin=6:color=white', '-q:v', '3', path.join(fdir, 'sheet_%02d.jpg')]);
  const sheets = [];
  for (let i = 0; i * 6 < frames.length; i++) {
    const file = `frames/sheet_${String(i + 1).padStart(2, '0')}.jpg`;
    if (fs.existsSync(path.join(dir, file))) sheets.push({ file, times: frames.slice(i * 6, i * 6 + 6).map((f) => f.t) });
  }
  return { frames, sheets };
}

function progressParser(total, cb) {
  return (s) => {
    const m = s.match(/time=(\d+):(\d+):([\d.]+)/);
    if (m && total) cb(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / total));
  };
}

const ramp = (a, b, r) => `clip((it-${a})/${r},0,1)*clip((${b}-it)/${r},0,1)`;

/**
 * Render the final edit.
 * tl = output of buildTimeline(): { keep, total, W, H, zooms, overlays, sfx, music }
 * assets: map of item id -> local file; captions: { list: concat file path, stripH } | null
 */
export async function render({ src, workDir, tl, assets, captions, outFile, onProgress = () => {}, log = () => {} }) {
  const { W, H, total } = tl;
  fs.mkdirSync(workDir, { recursive: true });

  // ---- Stage A: cut ----
  const cut = path.join(workDir, 'cut.mp4');
  const parts = [];
  tl.keep.forEach((k, i) => {
    const d = (k.e - k.s).toFixed(3);
    const fd = Math.min(0.012, (k.e - k.s) / 4).toFixed(3);
    parts.push(`[0:v]trim=start=${k.s}:end=${k.e},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(`[0:a]atrim=start=${k.s}:end=${k.e},asetpts=PTS-STARTPTS,afade=t=in:d=${fd},afade=t=out:st=${(d - fd).toFixed(3)}:d=${fd}[a${i}]`);
  });
  parts.push(`${tl.keep.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${tl.keep.length}:v=1:a=1[v][a]`);
  const scriptA = path.join(workDir, 'cut.filter');
  fs.writeFileSync(scriptA, parts.join(';\n'));
  log(`Cutting: keeping ${tl.keep.length} segment(s), ${total.toFixed(1)}s total`);
  await ff(['-i', src, scriptFlag(), scriptA, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', cut], { onStderr: progressParser(total, (p) => onProgress(p * 0.35)) });

  // ---- Stage B: compose ----
  const inputs = ['-i', cut];
  const f = [];
  let n = 1;
  let cur = '[0:v]';

  if (tl.zooms.length) {
    const R = 0.35;
    const z = '1+' + tl.zooms.map((zm) => `${(zm.scale - 1).toFixed(3)}*${ramp(zm.s, zm.e, R)}`).join('+');
    const fx = '0.5+' + tl.zooms.map((zm) => `${(zm.x - 0.5).toFixed(3)}*${ramp(zm.s, zm.e, R)}`).join('+');
    const fy = '0.5+' + tl.zooms.map((zm) => `${(zm.y - 0.5).toFixed(3)}*${ramp(zm.s, zm.e, R)}`).join('+');
    f.push(`${cur}scale=${W * 2}:${H * 2}:flags=lanczos,zoompan=z='${z}':x='clip((${fx})*iw-iw/zoom/2,0,iw-iw/zoom)':y='clip((${fy})*ih-ih/zoom/2,0,ih-ih/zoom)':d=1:s=${W}x${H}:fps=${FPS}[zv]`);
    cur = '[zv]';
  }

  const margin = Math.round(W * 0.025);
  const posXY = (pos) => ({
    center: ['(W-w)/2', '(H-h)/2'],
    'top-right': [`W-w-${margin}`, `${margin}`],
    'top-left': [`${margin}`, `${margin}`],
    'bottom-right': [`W-w-${margin}`, `H-h-${margin * 4}`],
    'bottom-left': [`${margin}`, `H-h-${margin * 4}`],
    top: ['(W-w)/2', `${margin}`],
  }[pos] || ['(W-w)/2', '(H-h)/2']);

  for (const ov of tl.overlays) {
    const file = assets[ov.id];
    if (!file) { log(`Skipping ${ov.type} "${ov.label}" (no media)`); continue; }
    const dur = (ov.e - ov.s);
    const isImage = ov.mediaKind === 'image';
    if (isImage) inputs.push('-loop', '1', '-framerate', String(FPS), '-t', dur.toFixed(3), '-i', file);
    else inputs.push('-stream_loop', '-1', '-t', dur.toFixed(3), '-i', file);
    const idx = n++;
    const fd = Math.min(Math.max(0.04, ov.fade ?? 0.12), dur / 2).toFixed(3);
    const fade = `format=yuva420p,fade=t=in:st=0:d=${fd}:alpha=1,fade=t=out:st=${Math.max(0, dur - fd).toFixed(3)}:d=${fd}:alpha=1`;
    const size = Math.min(0.9, Math.max(0.1, ov.size || (ov.type === 'meme' ? 0.42 : 0.36)));
    let chain, x = '0', y = '0';
    if (ov.type === 'text') {
      chain = `scale=${W}:${H},setsar=1`;
    } else if (ov.type === 'broll' && ov.mode !== 'pip') {
      chain = `fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
      if (isImage) {
        const frames = Math.max(1, Math.round(dur * FPS));
        chain = `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},setsar=1,zoompan=z='1+0.10*on/${frames}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${W}x${H}:fps=${FPS}`;
      }
    } else if (ov.type === 'broll') {
      const pw = Math.round(W * size / 2) * 2;
      chain = `fps=${FPS},scale=${pw}:-2,setsar=1,pad=iw+8:ih+8:4:4:color=white`;
      [x, y] = posXY(ov.position || 'top-right');
    } else { // meme
      const bw = Math.round(W * size), bh = Math.round(H * Math.min(0.9, size * 1.3));
      chain = `fps=${FPS},scale=w=${bw}:h=${bh}:force_original_aspect_ratio=decrease,setsar=1,pad=iw+10:ih+10:5:5:color=white`;
      [x, y] = posXY(ov.position || 'center');
    }
    f.push(`[${idx}:v]${chain},${fade},setpts=PTS-STARTPTS+${ov.s.toFixed(3)}/TB[o${idx}]`);
    f.push(`${cur}[o${idx}]overlay=x=${x}:y=${y}:eof_action=pass:enable='between(t,${ov.s.toFixed(3)},${ov.e.toFixed(3)})'[c${idx}]`);
    cur = `[c${idx}]`;
  }

  if (captions) {
    inputs.push('-f', 'concat', '-safe', '0', '-i', captions.list);
    const idx = n++;
    f.push(`[${idx}:v]fps=${FPS},format=rgba[cap]`);
    f.push(`${cur}[cap]overlay=x=0:y=${H - captions.stripH}:eof_action=pass[capd]`);
    cur = '[capd]';
  }
  f.push(`${cur}format=yuv420p[vout]`);

  // audio
  const amix = ['[0:a]aresample=48000,aformat=channel_layouts=stereo[base]'];
  const labels = ['[base]'];
  for (const s of tl.sfx) {
    const file = assets[s.id];
    if (!file) continue;
    inputs.push('-i', file);
    const idx = n++;
    const ms = Math.round(s.t * 1000);
    amix.push(`[${idx}:a]atrim=0:2.5,afade=t=out:st=2.2:d=0.3,aresample=48000,aformat=channel_layouts=stereo,volume=${(s.volume ?? 0.5).toFixed(2)},adelay=${ms}|${ms}[s${idx}]`);
    labels.push(`[s${idx}]`);
  }
  if (tl.music && assets.music) {
    inputs.push('-stream_loop', '-1', '-t', total.toFixed(3), '-i', assets.music);
    const idx = n++;
    amix.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${(tl.music.volume ?? 0.07).toFixed(3)},afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, total - 2).toFixed(2)}:d=2[mus]`);
    labels.push('[mus]');
  }
  if (labels.length > 1) amix.push(`${labels.join('')}amix=inputs=${labels.length}:duration=first:normalize=0,alimiter=limit=0.95[aout]`);
  else amix.push('[base]anull[aout]');

  const scriptB = path.join(workDir, 'compose.filter');
  fs.writeFileSync(scriptB, [...f, ...amix].join(';\n'));
  log(`Compositing: ${tl.zooms.length} zoom(s), ${tl.overlays.length} overlay(s), ${tl.sfx.length} sound effect(s)${captions ? ', captions' : ''}`);
  await ff([...inputs, scriptFlag(), scriptB, '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3), '-movflags', '+faststart', outFile], { onStderr: progressParser(total, (p) => onProgress(0.35 + p * 0.65)) });
  onProgress(1);
}
