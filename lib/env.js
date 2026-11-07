import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * When Rawcut is opened as a desktop app (Dock, Start menu, Finder) it doesn't inherit the
 * PATH from your terminal, so `claude`, `codex`, `ollama` and `whisper-cli` look "not installed".
 * Ask your login shell for its PATH and add the usual install folders.
 */
export function fixPath() {
  const sep = path.delimiter;
  const parts = new Set((process.env.PATH || '').split(sep).filter(Boolean));
  const home = os.homedir();
  if (process.platform !== 'win32') {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    try {
      const r = spawnSync(shell, ['-ilc', 'printf "__P__%s__P__" "$PATH"'], { timeout: 4000, encoding: 'utf8' });
      const m = String(r.stdout || '').match(/__P__(.*?)__P__/);
      if (m) m[1].split(':').forEach((p) => p && parts.add(p));
    } catch { }
    ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'), path.join(home, '.bun/bin'), path.join(home, '.claude/local')].forEach((p) => parts.add(p));
  } else {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    [path.join(appdata, 'npm'), path.join(home, '.local', 'bin'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama')].forEach((p) => parts.add(p));
  }
  process.env.PATH = [...parts].join(sep);
}
