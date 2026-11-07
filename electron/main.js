// Rawcut desktop app: runs the same local server inside Electron and opens it in a window.
import { app, BrowserWindow, session, desktopCapturer, shell, dialog, Menu } from 'electron';
import path from 'node:path';

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let url = null;

async function boot() {
  process.env.RAWCUT_DATA = path.join(app.getPath('userData'), 'data');
  process.env.RAWCUT_EMBEDDED = '1';
  const { start } = await import('../server.js');
  url = await start(+(process.env.PORT || 4777));

  // Screen recording: Electron needs to be told which screen to share.
  // macOS 15+ shows the system picker; elsewhere we share the main screen (+ system audio on Windows).
  session.defaultSession.setDisplayMediaRequestHandler(async (req, cb) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const screen = sources.find((s) => s.id.startsWith('screen')) || sources[0];
    cb(screen ? { video: screen, ...(process.platform === 'win32' && req.audioRequested ? { audio: 'loopback' } : {}) } : {});
  }, { useSystemPicker: true });
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'].includes(perm)));

  createWindow();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d0d0f', title: 'Rawcut', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL(url);
  // Links (API key pages, docs) open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, u) => { if (!u.startsWith(url)) { e.preventDefault(); shell.openExternal(u); } });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!win && url) createWindow(); });

if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));

app.whenReady().then(boot).catch((e) => { dialog.showErrorBox('Rawcut could not start', String(e?.stack || e)); app.quit(); });
