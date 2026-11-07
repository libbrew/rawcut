import fs from 'node:fs';
import path from 'node:path';
import { MODELS } from './config.js';
import { run, which, extractWav, extractMp3, FFMPEG } from './ffmpeg.js';

export const WHISPER_MODELS = {
  'ggml-tiny.en.bin': '75 MB · fastest, English',
  'ggml-base.en.bin': '142 MB · good, English',
  'ggml-small.en.bin': '466 MB · better, English',
  'ggml-base.bin': '142 MB · multilingual',
  'ggml-small.bin': '466 MB · multilingual, better',
};
export const modelUrl = (name) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${name}`;

// Built-in transcription (runs inside Rawcut, nothing to install). Models download on first use.
export const BUILTIN_MODELS = {
  tiny: 'onnx-community/whisper-tiny_timestamped',
  base: 'onnx-community/whisper-base_timestamped',
  small: 'onnx-community/whisper-small_timestamped',
};
const asrCache = {};
async function builtinTranscribe(T, src, log) {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = path.join(MODELS, 'hf');
  const id = BUILTIN_MODELS[T.builtinModel] || BUILTIN_MODELS.base;
  log(`Built-in Whisper (${T.builtinModel || 'base'}) — the first run downloads the model once…`);
  asrCache[id] ||= pipeline('automatic-speech-recognition', id, { dtype: 'q8' });
  const asr = await asrCache[id].catch((e) => { delete asrCache[id]; throw new Error('Could not load the built-in Whisper model (are you online for the first download?): ' + e.message); });
  const r = await run(FFMPEG, ['-v', 'error', '-nostdin', '-i', src, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { binary: true });
  const audio = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 4));
  const opts = { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 };
  if (T.language && T.language !== 'auto') opts.language = T.language;
  const out = await asr(audio, opts);
  const words = [];
  for (const c of out.chunks || []) {
    const w = c.text.trim(); if (isNoise(w)) continue;
    const [s, e] = c.timestamp; if (s == null) continue;
    if (words.length && !/^\s/.test(c.text)) { words.at(-1).w += w; words.at(-1).e = +(e ?? s).toFixed(2); }
    else words.push({ w, s: +s.toFixed(2), e: +(e ?? s + 0.2).toFixed(2) });
  }
  return { words };
}

const hasWhisperCpp = (T) => !!which('whisper-cli') && Object.keys(WHISPER_MODELS).some((m) => fs.existsSync(path.join(MODELS, m)));

const isNoise = (w) => !w || /^\[.*\]$|^\(.*\)$/.test(w) || /^[\s.,!?-]*$/.test(w);

/** Returns { words: [{w, s, e}] } in source seconds. */
export async function transcribe(cfg, src, dir, log = () => {}) {
  const T = cfg.transcribe;
  if (T.provider === 'none') return { words: [] };
  if (T.provider === 'builtin' || (T.provider === 'auto' && !hasWhisperCpp(T))) return builtinTranscribe(T, src, log);

  if (T.provider === 'openai') {
    const mp3 = path.join(dir, 'audio.mp3');
    if (!fs.existsSync(mp3)) await extractMp3(src, mp3);
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(mp3)], { type: 'audio/mpeg' }), 'audio.mp3');
    fd.append('model', T.openai.model);
    fd.append('response_format', 'verbose_json');
    fd.append('timestamp_granularities[]', 'word');
    if (T.language && T.language !== 'auto') fd.append('language', T.language);
    const r = await fetch(`${T.openai.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${T.openai.key}` }, body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Transcription API: ' + (d.error?.message || r.status));
    return { words: (d.words || []).map((x) => ({ w: x.word.trim(), s: +x.start.toFixed(2), e: +x.end.toFixed(2) })).filter((x) => !isNoise(x.w)) };
  }

  // whisper.cpp (provider 'local', or 'auto' when it is installed)
  let model = path.join(MODELS, T.localModel);
  if (!fs.existsSync(model)) { const any = Object.keys(WHISPER_MODELS).find((m) => fs.existsSync(path.join(MODELS, m))); if (any) { model = path.join(MODELS, any); T.localModel = any; } }
  if (!fs.existsSync(model)) throw new Error(`Whisper model ${T.localModel} not downloaded yet. Open Settings → Transcription and click Download.`);
  const wav = path.join(dir, 'audio.wav');
  if (!fs.existsSync(wav)) await extractWav(src, wav);
  const lang = T.localModel.includes('.en') ? 'en' : (T.language || 'auto');
  const outBase = path.join(dir, 'whisper');
  log(`Running whisper.cpp (${T.localModel})…`);
  const r = await run('whisper-cli', ['-m', model, '-f', wav, '-l', lang, '-ml', '1', '-sow', '-oj', '-of', outBase, '-np'], { timeout: 60 * 60e3 })
    .catch((e) => { throw new Error('whisper-cli not found. Install with: brew install whisper-cpp. ' + e.message); });
  if (r.code !== 0) throw new Error('whisper-cli failed: ' + r.stderr.slice(-500));
  const d = JSON.parse(fs.readFileSync(outBase + '.json', 'utf8'));
  const words = [];
  for (const seg of d.transcription || []) {
    const raw = seg.text || '';
    const w = raw.trim();
    if (isNoise(w)) continue;
    const s = seg.offsets.from / 1000, e = seg.offsets.to / 1000;
    if (words.length && !/^\s/.test(raw)) {
      words.at(-1).w += w; words.at(-1).e = +e.toFixed(2); // continuation token
    } else words.push({ w, s: +s.toFixed(2), e: +e.toFixed(2) });
  }
  return { words };
}
