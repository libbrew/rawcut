import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The desktop app passes RAWCUT_DATA (its user-data folder); otherwise data lives next to the code.
export const DATA = process.env.RAWCUT_DATA || path.join(ROOT, 'data');
export const PROJECTS = path.join(DATA, 'projects');
export const MODELS = path.join(DATA, 'models');
const CONFIG_FILE = path.join(DATA, 'config.json');

for (const d of [DATA, PROJECTS, MODELS]) fs.mkdirSync(d, { recursive: true });

export const DEFAULTS = {
  llm: {
    provider: 'claudecode', // anthropic | openai | ollama | claudecode | codex | custom
    vision: true,
    anthropic: { key: '', model: 'claude-sonnet-5-5' },
    openai: { key: '', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
    ollama: { url: 'http://127.0.0.1:11434', model: 'llama3.2-vision' },
    claudecode: { model: '' },
    codex: { model: '' },
    custom: { command: 'gemini -p' },
  },
  transcribe: {
    provider: 'auto', // auto (whisper.cpp if installed, else built-in) | builtin | local | openai | none
    builtinModel: 'base', // tiny | base | small
    localModel: 'ggml-base.en.bin',
    language: 'auto',
    openai: { key: '', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  },
  media: { pexels: '', pixabay: '', giphy: '', freesound: '' },
  style: {
    intensity: 'balanced', // subtle | balanced | heavy
    captions: true,
    broll: true,
    memes: true,
    sfx: true,
    zooms: true,
    removeSilence: true,
    music: false,
    notes: '',
  },
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  return out;
}

export function loadConfig() {
  try { return merge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); }
  catch { return structuredClone(DEFAULTS); }
}

export function saveConfig(cfg) {
  const merged = merge(loadConfig(), cfg);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  return merged;
}
