// Rawcut front-end ("Studio Light"). No framework, no build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (t) => { t = Math.max(0, +t || 0); const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(1).padStart(4, '0')}`; };
const fmtShort = (t) => { t = Math.max(0, Math.round(+t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const parseT = (v) => { v = String(v).trim().replace(/s$/i, '').trim(); if (v.includes(':')) { const [m, s] = v.split(':'); return +m * 60 + +s; } return +v; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => 'u' + Math.random().toString(36).slice(2, 9);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const bytes = (n) => (n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? Math.round(n / 1e6) + ' MB' : Math.round(n / 1e3) + ' KB');
const NATIVE = window.webkit?.messageHandlers?.rawcut;

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 3200); }

// Stroke icons (24×24 paths)
const I = {
  screen: 'M2.5 4h19v13h-19zM8 21h8M12 17v4', window: 'M3 5h18v14H3zM3 9h18', app: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  back: 'M15 18l-6-6 6-6', play: 'M7 4.5v15l12-7.5z', pause: 'M7 5h3v14H7zM14 5h3v14h-3z', send: 'M12 19V5M5 12l7-7 7 7',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13', eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  select: 'M5 3l14 8-6 2-2 6z', split: 'M12 3v18M6 8l-3 4 3 4M18 8l3 4-3 4', text: 'M5 5h14M12 5v14', plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V4M6 10l6-6 6 6M4 20h16', undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3', redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3',
};
const svg = (d, s = 16, extra = '') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}><path d="${d}"/></svg>`;
const svgFill = (d, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;

let CFG = null, STATUS = null;
const PROVIDERS = {
  claudecode: { name: 'Claude Code', sub: 'Your Claude plan, via the CLI' },
  codex: { name: 'Codex CLI', sub: 'Your ChatGPT plan, via the CLI' },
  ollama: { name: 'Ollama', sub: '100% local and free' },
  anthropic: { name: 'Anthropic API', sub: 'Your own API key' },
  openai: { name: 'OpenAI-compatible', sub: 'OpenAI, OpenRouter, Groq, LM Studio' },
  custom: { name: 'Custom command', sub: 'Gemini CLI or any tool' },
};
async function loadCfg() {
  CFG = await api('/api/config');
  STATUS = await api('/api/status').catch(() => null);
  const name = PROVIDERS[CFG.llm.provider]?.name || CFG.llm.provider;
  const ready = STATUS?.brainReady;
  $('#brainBadge').innerHTML = `<span class="dot ${ready ? 'on' : ''}"></span>${esc(name)} ${ready ? 'connected' : '· set up'}`;
}

// ------------------------------------------------------------------ router
let cleanup = null;
async function route() {
  cleanup?.(); cleanup = null;
  const h = location.hash.slice(2) || 'record';
  const [page, arg] = h.split('/');
  $$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === (page === 'p' ? 'projects' : page)));
  if (!CFG) await loadCfg();
  if (page === 'projects') return projectsView();
  if (page === 'settings') return settingsView();
  if (page === 'p') return editorView(arg);
  return recordView();
}
window.addEventListener('hashchange', route);
route();

// ------------------------------------------------------------------ upload helpers
function upload(url, blob, onProg) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.upload.onprogress = (e) => e.lengthComputable && onProg?.(e.loaded / e.total);
    x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch { } x.status < 300 ? res(d) : rej(new Error(d.error || x.responseText)); };
    x.onerror = () => rej(new Error('upload failed'));
    x.send(blob);
  });
}
/** Your own video file → a new project, then straight into the editor. */
async function importFile(f, onStatus) {
  if (!f) return;
  const ext = (f.name.split('.').pop() || 'mp4').toLowerCase();
  if (!/^video\//.test(f.type) && !/^(mp4|mov|m4v|webm|mkv|avi)$/.test(ext)) return toast('That isn\'t a video file. Try an .mp4, .mov or .webm.');
  try { await startProject(f, f.name.replace(/\.\w+$/, ''), ext, onStatus); } catch (err) { toast(err.message); onStatus(''); }
}
/** Lets you drop a video anywhere on `el`. */
function dropZone(el, onFile, onOver) {
  let n = 0;
  el.addEventListener('dragenter', (e) => { if (![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); if (n++ === 0) onOver(true); });
  el.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  el.addEventListener('dragleave', () => { if (--n <= 0) { n = 0; onOver(false); } });
  el.addEventListener('drop', (e) => { e.preventDefault(); n = 0; onOver(false); onFile(e.dataTransfer.files[0]); });
}
async function startProject(blob, name, ext, onStatus) {
  const { id } = await upload(`/api/projects?name=${encodeURIComponent(name)}&ext=${ext}`, blob, (p) => onStatus(`Uploading… ${Math.round(p * 100)}%`));
  await api(`/api/projects/${id}/analyze`, { method: 'POST', body: {} });
  location.hash = `#/p/${id}`;
}

// ------------------------------------------------------------------ record
const SOURCES = [
  { k: 'monitor', native: 'display', name: 'Entire screen', sub: NATIVE ? 'Pick a display in the macOS picker' : 'Your whole display', icon: I.screen },
  { k: 'window', native: 'window', name: 'One window', sub: 'Choose it in the picker', icon: I.window },
  { k: NATIVE ? 'app' : 'browser', native: 'app', name: NATIVE ? 'One app' : 'A browser tab', sub: NATIVE ? 'All of its windows' : 'Just one tab', icon: I.app },
];
let srcPick = 'monitor';

function recordView() {
  view.innerHTML = `<div class="rec">
    <section class="rec-main">
      <div id="setupSlot"></div>
      <div><h1>New recording</h1><p class="muted" style="margin:6px 0 0">Pick a source. When you stop, your editor watches the whole take before it cuts anything.</p></div>
      <div class="sources" role="radiogroup" aria-label="What to record">
        ${SOURCES.map((s) => `<button class="source ${s.k === srcPick ? 'on' : ''}" role="radio" aria-checked="${s.k === srcPick}" data-src="${s.k}">${svg(s.icon, 22)}<b>${s.name}</b><small>${s.sub}</small></button>`).join('')}
      </div>
      <div class="stage" id="stage"><span class="tc" id="timer">00:00:00</span><span class="hint" id="stageHint">${NATIVE ? 'PRESS START, THEN PICK WHAT TO SHARE' : 'YOUR SCREEN SHOWS HERE WHILE YOU RECORD'}<br><br>OR DROP A VIDEO FILE HERE TO EDIT IT</span><div class="drophint">Drop to edit this video</div></div>
      <div id="post"></div>
      <div class="recbar">
        <label class="pill"><input type="checkbox" id="optMic" checked> Microphone <span class="muted" id="micName" style="font-size:13px"></span>${NATIVE ? '' : '<span class="meter" aria-hidden="true"><i id="micLvl"></i></span>'}</label>
        <label class="pill"><input type="checkbox" id="optSys" checked> Computer sound</label>
        <span class="muted" id="recStatus" style="font-size:13px"></span>
        <label class="upbtn"><input type="file" id="fileIn2" accept="video/*,.mov,.mkv" class="sr">${svg(I.upload)} Upload a video</label>
        <button class="dark recbtn" id="recBtn"><span class="rd"></span><span id="recLabel">Start recording</span><span class="mono faint" style="font-size:12px">⌘⇧R</span></button>
      </div>
    </section>
    <aside class="rec-side">
      <div class="row" style="justify-content:space-between"><span class="eyebrow">Recent</span>
        <label style="font-size:13px;font-weight:500;color:var(--accent-text);cursor:pointer">Import video<input type="file" id="fileIn" accept="video/*,.mov,.mkv" class="sr"></label></div>
      <div id="recentList" class="muted">Loading…</div>
    </aside>
  </div>`;
  const btn = $('#recBtn'), status = $('#recStatus'), stage = $('#stage');
  const setStatus = (t) => { status.textContent = t; };

  if (STATUS && !STATUS.brainReady) {
    const found = [STATUS.claude && 'Claude Code', STATUS.codex && 'Codex', STATUS.ollama?.length && 'Ollama'].filter(Boolean);
    $('#setupSlot').innerHTML = `<div class="card setup"><b>One step before your first edit: connect an AI.</b>
      <span class="muted">${found.length ? `Found on this computer: ${found.join(', ')}.` : 'Use Claude Code or Codex (your existing plan), Ollama (free, local), or any API key.'}</span>
      <a href="#/settings" style="margin-left:auto"><button class="primary">Set up</button></a></div>`;
  }
  $$('[data-src]').forEach((b) => (b.onclick = () => { srcPick = b.dataset.src; $$('[data-src]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); }); }));

  api('/api/projects').then((list) => {
    $('#recentList').classList.remove('muted');
    $('#recentList').innerHTML = list.length ? list.slice(0, 6).map((p) => `<a class="recent" href="#/p/${p.id}">${p.thumb ? `<img class="thumb" src="${p.thumb}" alt="">` : '<span class="thumb"></span>'}
      <span style="display:flex;flex-direction:column;gap:3px;min-width:0"><span class="t">${esc(p.name)}</span><span class="m">${p.duration ? fmtShort(p.duration) : ''}${p.edited ? ' → ' + fmtShort(p.edited) + ' · edited' : ' · ' + esc(p.status)}</span></span></a>`).join('')
      : '<p class="muted" style="margin:0">Your recordings show up here.</p>';
  }).catch(() => { });

  // mic level meter (browser only)
  let meterStream = null, meterCtx = null, raf = 0;
  async function startMeter(stream) {
    if (NATIVE || !$('#micLvl')) return;
    try {
      meterStream = stream || await navigator.mediaDevices.getUserMedia({ audio: true });
      $('#micName').textContent = (meterStream.getAudioTracks()[0]?.label || '').replace(/\s*\(.*\)$/, '').slice(0, 28);
      meterCtx = new AudioContext(); const an = meterCtx.createAnalyser(); an.fftSize = 512;
      meterCtx.createMediaStreamSource(meterStream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => { an.getByteTimeDomainData(buf); let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128)); const el = $('#micLvl'); if (el) el.style.width = Math.min(100, peak / 0.9) + '%'; raf = requestAnimationFrame(loop); };
      loop();
    } catch { }
  }
  function stopMeter() { cancelAnimationFrame(raf); meterCtx?.close().catch(() => { }); meterCtx = null; if (!rec) meterStream?.getTracks().forEach((t) => t.stop()); meterStream = null; }
  navigator.permissions?.query({ name: 'microphone' }).then((p) => { if (p.state === 'granted' && $('#optMic')?.checked) startMeter(); }).catch(() => { });
  $('#optMic').onchange = (e) => { if (e.target.checked) startMeter(); else stopMeter(); };

  let rec = null, chunks = [], streams = [], t0 = 0, tick = null, ac = null, ext = 'webm';
  const startTimer = () => { t0 = Date.now(); $('#timer').classList.add('live'); tick = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); $('#timer').textContent = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }, 250); };
  const stopTimer = () => { clearInterval(tick); $('#timer')?.classList.remove('live'); };
  const setRecording = (on) => { btn.classList.toggle('on', on); $('#recLabel').textContent = on ? 'Stop recording' : 'Start recording'; };

  async function start() {
    try {
      $('#post').innerHTML = '';
      const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30, displaySurface: srcPick }, audio: $('#optSys').checked });
      streams = [display];
      let mic = null;
      if ($('#optMic').checked) { try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); streams.push(mic); stopMeter(); startMeter(mic); } catch { toast('Microphone not available, recording without it'); } }
      ac = new AudioContext(); const dest = ac.createMediaStreamDestination();
      for (const s of [display, mic]) if (s && s.getAudioTracks().length) ac.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest);
      const stream = new MediaStream([...display.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      const mime = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
      ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
      chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = done;
      rec.start(1000);
      display.getVideoTracks()[0].onended = stop;
      const live = document.createElement('video'); live.muted = true; live.autoplay = true; live.playsInline = true; live.srcObject = display;
      $('#stageHint')?.remove(); stage.querySelector('video')?.remove(); stage.appendChild(live);
      startTimer(); setRecording(true); setStatus('');
    } catch (e) { setStatus(e.name === 'NotAllowedError' ? 'Recording cancelled' : 'Could not start: ' + e.message); }
  }
  function stop() { if (rec && rec.state !== 'inactive') rec.stop(); }
  function done() {
    stopTimer(); streams.forEach((s) => s.getTracks().forEach((t) => t.stop())); ac?.close(); setRecording(false);
    const blob = new Blob(chunks, { type: rec.mimeType });
    const url = URL.createObjectURL(blob);
    stage.querySelector('video')?.remove();
    const v = document.createElement('video'); v.src = url; v.controls = true; stage.appendChild(v);
    setStatus(`Recorded ${$('#timer').textContent}`);
    $('#post').innerHTML = `<div class="row"><label class="grow field"><span class="sr">Name</span><input type="text" id="recName" value="Screen recording ${esc(new Date().toLocaleString())}"></label>
      <a href="${url}" download="recording.${ext}"><button>Save raw file</button></a><button class="primary" id="goEdit">Edit with AI</button></div>`;
    $('#goEdit').onclick = async () => { $('#goEdit').disabled = true; try { await startProject(blob, $('#recName').value, ext, setStatus); } catch (e) { toast(e.message); $('#goEdit').disabled = false; } };
    rec = null;
  }

  // Inside the native Mac app, ScreenCaptureKit records (system picker, system audio + mic).
  let nstate = 'idle';
  if (NATIVE) {
    window.rawcutNative = (ev) => {
      if (ev.event === 'picking') setStatus('Pick what to record in the macOS picker…');
      if (ev.event === 'recording') { nstate = 'recording'; setRecording(true); startTimer(); setStatus(''); const h = $('#stageHint'); if (h) h.textContent = 'RECORDING · THE MENU BAR SHOWS WHAT IS SHARED'; }
      if (ev.event === 'saving') setStatus('Saving…');
      if (ev.event === 'uploading') { stopTimer(); setRecording(false); setStatus('Handing it to your editor…'); }
      if (ev.event === 'cancelled') { nstate = 'idle'; setStatus(''); }
      if (ev.event === 'error') { nstate = 'idle'; stopTimer(); setRecording(false); setStatus(ev.message); toast(ev.message); }
      if (ev.event === 'done') { nstate = 'idle'; location.hash = `#/p/${ev.id}`; }
    };
  }
  const toggle = () => {
    if (NATIVE) {
      if (nstate === 'recording') { nstate = 'stopping'; NATIVE.postMessage({ cmd: 'stop' }); }
      else if (nstate === 'idle') { nstate = 'starting'; NATIVE.postMessage({ cmd: 'start', mic: $('#optMic').checked, sys: $('#optSys').checked, mode: SOURCES.find((s) => s.k === srcPick)?.native }); }
    } else rec ? stop() : start();
  };
  btn.onclick = toggle;
  const onKey = (e) => { if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'r') { e.preventDefault(); toggle(); } };
  document.addEventListener('keydown', onKey);
  for (const inp of ['#fileIn', '#fileIn2']) $(inp).onchange = (e) => importFile(e.target.files[0], setStatus);
  dropZone($('.rec'), (f) => { if (!rec) importFile(f, setStatus); }, (over) => stage.classList.toggle('dropping', over));
  cleanup = () => { document.removeEventListener('keydown', onKey); if (!NATIVE) stop(); stopTimer(); stopMeter(); };
}

// ------------------------------------------------------------------ projects
async function projectsView() {
  view.innerHTML = `<div class="page" id="ppage"><div class="row"><h1 class="grow">Projects</h1><span class="muted" id="pstat" style="font-size:13px"></span><label class="upbtn" style="height:36px"><input type="file" id="pIn" accept="video/*,.mov,.mkv" class="sr">${svg(I.upload)} Upload a video</label><a href="#/record"><button class="dark"><span style="width:10px;height:10px;border-radius:50%;background:var(--rec)"></span>New recording</button></a></div><div id="plist"></div></div>`;
  const setS = (t) => { $('#pstat').textContent = t; };
  $('#pIn').onchange = (e) => importFile(e.target.files[0], setS);
  dropZone($('#ppage'), (f) => importFile(f, setS), (over) => $('#ppage').classList.toggle('dropping', over));
  const list = await api('/api/projects');
  $('#plist').innerHTML = list.length ? `<div class="pgrid">${list.map((p) => `
    <a class="card pcard" href="#/p/${p.id}">
      ${p.thumb ? `<img class="img" src="${p.thumb}" alt="">` : '<div class="img"></div>'}
      <div class="meta"><b>${esc(p.name)}</b>
        <div class="row" style="gap:8px"><span class="tag ${p.status === 'rendered' ? 'ok' : ''}">${esc({ rendered: 'Exported', planned: 'Edit ready', analyzing: 'Watching…', uploaded: 'Recorded' }[p.status] || p.status)}</span>
        <span class="mono muted" style="font-size:12px">${p.duration ? fmtShort(p.duration) : ''}${p.edited ? ' → ' + fmtShort(p.edited) : ''} · ${new Date(p.created).toLocaleDateString()}</span></div></div>
    </a>`).join('')}</div>` : '<div class="card empty" style="margin-top:20px">No projects yet. <a href="#/record">Record something</a>, or drop a video file here.</div>';
}

// ------------------------------------------------------------------ editor
const KIND = {
  cuts: { label: 'Cut', cls: 'b-cut', range: true },
  zooms: { label: 'Zoom', cls: 'b-zoom', range: true },
  broll: { label: 'B-roll', cls: 'b-broll', range: true },
  memes: { label: 'Meme', cls: 'b-meme', range: true },
  texts: { label: 'Text', cls: 'b-text', range: true },
  sfx: { label: 'Sound', cls: 'b-sfx', range: false },
};
const TRACKS = [
  { k: 'video', name: 'Video' }, { k: 'texts', name: 'Text' }, { k: 'media', name: 'Media' },
  { k: 'zooms', name: 'Zoom' }, { k: 'caps', name: 'Captions' }, { k: 'sfx', name: 'Sound' },
];
const titleOf = (k, it) => k === 'cuts' ? (it.auto ? 'Pause' : (it.manual && it.reason === 'Removed by you' ? 'Removed by you' : 'Cut'))
  : k === 'zooms' ? `Zoom ${(+it.scale || 1.5).toFixed(1)}×` : k === 'texts' ? (it.text || 'Text')
  : k === 'memes' ? (it.kind === 'gif' ? (it.query || 'GIF') : (it.template || it.query || 'Meme')) : (it.query || it.asset?.title || '');
const kindLabel = (k, it) => (k === 'memes' && it.kind === 'gif' ? 'GIF' : KIND[k].label);
const thumbOf = (a) => (a ? a.thumb || (a.kind === 'image' ? a.url : '') : '');
const CHIPS = ['Make it shorter', 'More b-roll', 'No memes', 'Cut the intro'];

async function editorView(id) {
  let P = await api(`/api/projects/${id}`);
  let plan = P.plan || null;
  let style = { ...CFG.style, protectManual: true, ...(P.style || {}) };
  let sel = null, mode = 'edit', zoomLvl = 1, snap = true, alive = true, saveT = null, sideTab = 'edits', jobOpen = false;
  let history = [], future = [], pending = null, chatUndo = null;
  const hidden = new Set();
  const D = () => P.duration || 0;
  const norm = () => { if (!plan) return; for (const k of ['cuts', 'zooms', 'broll', 'memes', 'sfx', 'texts', 'splits']) plan[k] ||= []; };
  norm();

  view.innerHTML = `<div class="ed">
    <div class="ed-head">
      <a href="#/projects" aria-label="Back to projects" class="muted" style="display:flex">${svg(I.back, 18)}</a>
      <div class="ttl"><b id="pTitle"></b><span id="pSub"></span></div>
      <div class="acts">
        <div class="seg" id="intensity" role="group" aria-label="How much editing">${['subtle', 'balanced', 'heavy'].map((x) => `<button data-v="${x}">${x[0].toUpperCase() + x.slice(1)}</button>`).join('')}</div>
        <button id="replan" title="Ask the AI to plan the edit again with this style">Re-plan</button>
        <a id="dl" hidden><button>Download</button></a>
        <button class="primary" id="exportBtn">Export</button>
        <button class="ghost icon" id="delP" title="Delete project" aria-label="Delete project">${svg(I.trash, 16)}</button>
      </div>
    </div>
    <div id="job"></div>
    <div class="ed-main">
      <section class="ed-video">
        <div class="screen" id="screen"><div class="frame" id="frame"><video id="vid" playsinline preload="auto"></video><div id="ovl"></div></div></div>
        <div class="transport">
          <button class="dark icon" id="play" aria-label="Play">${svgFill(I.play)}</button>
          <span class="tc" id="tc"></span>
          <span class="note" id="viewNote"></span>
          <div class="seg" id="viewSeg" role="group" aria-label="What to watch" style="margin-left:auto">
            <button data-m="orig">Original</button><button data-m="edit">Edited</button><button data-m="export" id="segExport">Last export</button>
          </div>
        </div>
      </section>
      <aside class="panel" aria-label="Edit details">
        <div class="tabs" role="tablist" id="sideTabs"></div>
        <div class="scroll" id="sideBody"></div>
      </aside>
      <aside class="panel chatp" aria-label="Chat with your editor">
        <div class="chat-head"><b>Ask the editor</b><span class="muted" style="margin-left:auto;font-size:12px;display:flex;gap:6px;align-items:center"><span class="dot ${STATUS?.brainReady ? 'on' : ''}"></span>${esc(PROVIDERS[CFG.llm.provider]?.name || '')}</span></div>
        <div class="msgs" id="msgs" aria-live="polite"></div>
        <div class="chat-in">
          <div class="chips">${CHIPS.map((c) => `<button data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>
          <form class="composer" id="chatForm"><label class="sr" for="ask">Message the editor</label>
            <textarea id="ask" rows="2" placeholder="Ask for a change, e.g. “b-roll of Tokyo at 0:42”"></textarea>
            <button class="primary icon" type="submit" aria-label="Send">${svg(I.send, 16, 'stroke-width="2.2"')}</button></form>
        </div>
      </aside>
    </div>
    <section class="tl" aria-label="Timeline">
      <div class="tl-left">
        <div class="tools" role="toolbar" aria-label="Editing tools">
          <button class="on" data-tool="select" title="Select and drag clips (V)">${svg(I.select)} Select <kbd>V</kbd></button>
          <button data-tool="split" title="Split at the playhead (⌘B)">${svg(I.split)} Split <kbd>⌘B</kbd></button>
          <button data-tool="delete" title="Delete the selection (⌫)">${svg(I.trash)} Delete <kbd>⌫</kbd></button>
          <button data-tool="text" title="Add a text title (T)">${svg(I.text)} Text <kbd>T</kbd></button>
          <button data-tool="media" title="Add your own image, video or sound (M)">${svg(I.plus)} Media <kbd>M</kbd></button>
          <button data-tool="undo" title="Undo (⌘Z)">${svg(I.undo)} Undo</button>
          <button data-tool="redo" title="Redo (⇧⌘Z)">${svg(I.redo)} Redo</button>
          <span class="sep" aria-hidden="true"></span>
          <label class="chk"><input type="checkbox" id="snap" checked> Snap to words</label>
          <label class="chk" title="When on, the AI keeps anything you changed by hand when it re-plans or revises"><input type="checkbox" id="protect"> Protect my edits</label>
          <label class="row" style="margin-left:auto;gap:8px;font-size:13px;color:var(--mute)">Zoom <input type="range" id="tlZoom" min="1" max="12" step="0.5" value="1" style="width:110px"></label>
        </div>
        <div class="tl-body"><div class="tl-names" id="tlNames"></div><div class="tl-scroll" id="tlScroll"><div class="tl-inner" id="tlInner"></div></div></div>
      </div>
      <aside class="insp" id="insp" aria-label="Selected clip"></aside>
    </section>
    <input type="file" id="mediaIn" class="sr" accept="image/*,video/*,audio/*">
  </div>`;

  const vid = $('#vid'), frame = $('#frame'), ovl = $('#ovl'), inner = $('#tlInner'), insp = $('#insp');
  $('#protect').checked = style.protectManual !== false;

  // ---------- helpers
  const all = (k) => (plan?.[k] || []);
  const findIt = (k, iid) => all(k).find((x) => x.id === iid);
  const selItem = () => (sel && KIND[sel.k] ? findIt(sel.k, sel.id) : null);
  const on = (x) => x.enabled !== false;
  const snapshot = () => JSON.stringify(plan);
  const commit = () => { if (!plan) return; history.push(snapshot()); if (history.length > 120) history.shift(); future = []; };
  const savePlan = () => { clearTimeout(saveT); saveT = setTimeout(() => api(`/api/projects/${id}/plan`, { method: 'PUT', body: { plan, style } }).catch((e) => toast(e.message)), 350); };
  const changed = () => { savePlan(); paintTimeline(); paintSide(); paintHead(); updatePreview(); };
  const pct = (t) => (D() ? (t / D()) * 100 : 0);
  const cutsOn = () => all('cuts').filter(on).sort((a, b) => a.start - b.start);
  const removed = () => { let r = 0, end = 0; for (const c of cutsOn()) { const s = Math.max(c.start, end); if (c.end > s) r += c.end - s; end = Math.max(end, c.end); } return r; };
  const words = () => P.transcript?.words || [];
  function snapT(t, rectW) {
    if (!snap) return t;
    const tol = (8 / rectW) * D();
    let best = t, bd = tol;
    for (const w of words()) for (const x of [w.s, w.e]) { const d = Math.abs(x - t); if (d < bd) { bd = d; best = x; } }
    const ph = vid.currentTime; if (Math.abs(ph - t) < bd) best = ph;
    return best;
  }
  function segments() {
    const keep = []; let t = 0;
    for (const c of cutsOn()) { if (c.start > t + 0.05) keep.push([t, c.start]); t = Math.max(t, c.end); }
    if (D() > t + 0.05) keep.push([t, D()]);
    const splits = (plan?.splits || []).slice().sort((a, b) => a - b);
    const out = [];
    for (const [s, e] of keep) { let a = s; for (const x of splits) if (x > a + 0.1 && x < e - 0.1) { out.push([a, x]); a = x; } out.push([a, e]); }
    return out;
  }
  const seek = (t) => { vid.currentTime = clamp(t, 0, D() || vid.duration || 0); updateClock(); updatePreview(); };

  // ---------- header, job
  function paintHead() {
    $('#pTitle').textContent = P.understanding?.title || P.name;
    const n = plan ? ['zooms', 'broll', 'memes', 'sfx', 'texts'].reduce((a, k) => a + all(k).filter(on).length, 0) + cutsOn().length : 0;
    $('#pSub').textContent = D() ? `${fmt(D())} raw → ${fmt(D() - removed())} edited${plan ? ` · ${n} edits` : ''}` : 'Preparing…';
    $$('#intensity button').forEach((b) => b.classList.toggle('on', b.dataset.v === style.intensity));
    const busy = P.job?.status === 'running';
    $('#exportBtn').disabled = !plan || busy; $('#replan').disabled = !P.understanding || busy;
    const last = P.renders?.at(-1);
    $('#dl').hidden = !last; if (last) { $('#dl').href = `/files/${id}/${last.file}`; $('#dl').setAttribute('download', `${(P.understanding?.title || 'rawcut').replace(/[^\w\- ]+/g, '').slice(0, 60)}.mp4`); }
    $('#segExport').hidden = !last;
  }
  function paintJob() {
    const j = P.job, el = $('#job');
    if (!j || j.status === 'done') { el.innerHTML = ''; return; }
    const running = j.status === 'running';
    el.innerHTML = `<div class="job ${running ? '' : 'err'}">
      <div class="row" style="gap:12px">${running ? `<b>${esc(j.step || 'Working')}…</b><span class="muted">${Math.round((j.progress || 0) * 100)}%</span>` : `<b class="bad">Something went wrong</b><span class="grow">${esc(j.error || '')}</span>`}
        <span style="margin-left:auto" class="row">${!running && j.kind === 'analyze' ? '<button class="sm" id="retry">Try again</button><a href="#/settings"><button class="sm">Settings</button></a>' : ''}
        <button class="ghost sm" id="jobLog">${jobOpen ? 'Hide details' : 'Details'}</button>${!running ? '<button class="ghost sm" id="jobX">Dismiss</button>' : ''}</span></div>
      ${running ? `<div class="bar"><i style="width:${Math.round((j.progress || 0) * 100)}%"></i></div>` : ''}
      ${jobOpen ? `<div class="log" id="jlog">${esc((j.log || []).map((l) => l.m).join('\n'))}</div>` : ''}</div>`;
    $('#jobLog').onclick = () => { jobOpen = !jobOpen; paintJob(); };
    $('#jobX') && ($('#jobX').onclick = () => { P.job = null; paintJob(); });
    $('#retry') && ($('#retry').onclick = () => runJob(`/api/projects/${id}/analyze`, {}));
    const lg = $('#jlog'); if (lg) lg.scrollTop = lg.scrollHeight;
  }

  // ---------- video + live preview
  function setSrc() {
    const last = P.renders?.at(-1);
    if (mode === 'export' && !last) mode = 'edit';
    $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    const want = mode === 'export' ? `/files/${id}/${last.file}?v=${last.created}` : P.duration ? `/files/${id}/source.mp4` : `/files/${id}/${P.raw}`;
    if (vid.getAttribute('src') !== want) { const t = mode === 'export' ? 0 : vid.currentTime; vid.src = want; vid.addEventListener('loadedmetadata', () => { if (mode !== 'export') vid.currentTime = t; }, { once: true }); }
    $('#viewNote').textContent = mode === 'edit' ? 'Live preview · Export bakes in media and captions' : mode === 'export' ? 'Your last export' : 'Untouched recording';
    if (P.width && P.height) frame.style.setProperty('--ar', `${P.width}/${P.height}`);
    updatePreview();
  }
  function updateClock() {
    const t = vid.currentTime || 0, tot = mode === 'export' ? (vid.duration || 0) : D();
    $('#tc').innerHTML = `${fmt(t)} <span class="muted">/ ${fmt(tot)}</span>`;
    const ph = $('#phd'); if (ph) { ph.style.display = mode === 'export' ? 'none' : ''; ph.style.left = pct(t) + '%'; }
  }
  const cornerCSS = (pos, wPct, bottomPad = 10) => {
    const m = 2.5, p = pos || 'top-right';
    return `width:${wPct}%;${p.includes('left') ? `left:${m}%` : p === 'center' || p === 'top' ? `left:${(100 - wPct) / 2}%` : `right:${m}%`};${p.startsWith('bottom') ? `bottom:${bottomPad}%` : p === 'center' ? 'top:50%;transform:translateY(-50%)' : `top:${m * 1.6}%`}`;
  };
  function updatePreview() {
    if (!plan || mode !== 'edit') { ovl.innerHTML = ''; vid.style.transform = ''; return; }
    const t = vid.currentTime, act = (x) => on(x) && t >= x.start && t < x.end;
    let h = '';
    for (const b of all('broll').filter(act)) {
      const s = sel?.id === b.id ? 'sel' : '', bg = thumbOf(b.asset) ? `background-image:url('${esc(thumbOf(b.asset))}')` : '';
      h += b.mode === 'pip' ? `<div class="ov corner ${s}" data-k="broll" data-id="${b.id}" style="${cornerCSS(b.position, (b.size || 0.36) * 100)};aspect-ratio:16/10;${bg}"><span class="lab">${esc(b.query || '')}</span></div>`
        : `<div class="ov full ${s}" data-k="broll" data-id="${b.id}" style="${bg}"><span class="lab">${esc(b.query || '')}</span></div>`;
    }
    for (const m of all('memes').filter(act)) {
      const s = sel?.id === m.id ? 'sel' : '', w = (m.size || 0.42) * 100;
      h += `<div class="ov meme ${s}" data-k="memes" data-id="${m.id}" style="${cornerCSS(m.position || 'center', w)};aspect-ratio:1/1;background-image:url('${esc(thumbOf(m.asset))}')">
        ${m.top_text ? `<div class="ovtext" style="top:4%;font-family:Anton,Impact,sans-serif;font-weight:400;font-size:${w / 10}cqw">${esc(m.top_text)}</div>` : ''}${m.bottom_text ? `<div class="ovtext" style="bottom:4%;font-family:Anton,Impact,sans-serif;font-weight:400;font-size:${w / 10}cqw">${esc(m.bottom_text)}</div>` : ''}</div>`;
    }
    for (const x of all('texts').filter(act)) {
      const top = x.position === 'middle' ? 'top:50%;transform:translateY(-50%)' : x.position === 'bottom' ? 'bottom:32%' : 'top:10%';
      h += `<div class="ovtext" style="${top};font-size:${4.2 * (x.size || 1)}cqw">${esc(x.text)}</div>`;
    }
    if (style.captions !== false) {
      const ws = words(), cuts = cutsOn(), i = ws.findIndex((w) => t >= w.s && t < w.e + 0.3);
      if (i >= 0 && !cuts.some((c) => t >= c.start && t < c.end)) {
        const a = Math.floor(i / 3) * 3, grp = ws.slice(a, a + 3);
        h += `<div class="capprev">${grp.map((w, j) => `<span class="${a + j === i ? 'hi' : ''}">${esc(w.w)}</span>`).join(' ')}</div>`;
      }
    }
    ovl.innerHTML = h;
    const z = all('zooms').find(act);
    vid.style.transformOrigin = z ? `${(z.x ?? 0.5) * 100}% ${(z.y ?? 0.5) * 100}%` : '50% 50%';
    vid.style.transform = z ? `scale(${z.scale || 1.5})` : '';
  }
  let raf = 0;
  const loop = () => {
    if (mode === 'edit' && plan && !vid.paused) { const c = cutsOn().find((c) => vid.currentTime >= c.start && vid.currentTime < c.end - 0.04); if (c) vid.currentTime = c.end; }
    updateClock(); updatePreview();
    if (!vid.paused && alive) raf = requestAnimationFrame(loop);
  };
  vid.addEventListener('play', () => { $('#play').innerHTML = svgFill(I.pause); $('#play').setAttribute('aria-label', 'Pause'); cancelAnimationFrame(raf); loop(); });
  vid.addEventListener('pause', () => { $('#play').innerHTML = svgFill(I.play); $('#play').setAttribute('aria-label', 'Play'); updateClock(); });
  vid.addEventListener('seeked', () => { updateClock(); updatePreview(); });
  vid.addEventListener('loadedmetadata', updateClock);
  $('#play').onclick = () => (vid.paused ? vid.play() : vid.pause());
  $$('#viewSeg button').forEach((b) => (b.onclick = () => { mode = b.dataset.m; setSrc(); }));

  // Drag a corner overlay on the video to move it to another corner.
  ovl.addEventListener('pointerdown', (e) => {
    const o = e.target.closest('.ov'); if (!o) return;
    const k = o.dataset.k, it = findIt(k, o.dataset.id); if (!it) return;
    if (sel?.id !== it.id) { sel = { k, id: it.id }; paintTimeline(); paintInspector(); paintSide(); updatePreview(); return; }
    if (o.classList.contains('full')) return;
    e.preventDefault(); const r = frame.getBoundingClientRect(); let moved = false; const before = snapshot();
    const mv = (ev) => { const x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height; const p = (y < 0.5 ? 'top' : 'bottom') + '-' + (x < 0.5 ? 'left' : 'right'); if (p !== it.position) { moved = true; it.position = p; it.manual = true; updatePreview(); } };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); if (moved) { history.push(before); future = []; savePlan(); paintInspector(); } };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });

  // ---------- side panel: understanding / edits / style
  function paintSide() {
    const nEdits = plan ? ['cuts', 'zooms', 'broll', 'memes', 'sfx', 'texts'].reduce((a, k) => a + all(k).filter((x) => !x.auto).length, 0) + (all('cuts').some((c) => c.auto) ? 1 : 0) : 0;
    $('#sideTabs').innerHTML = [['understand', 'Understanding'], ['edits', `Edits <span class="count">${nEdits}</span>`], ['style', 'Style']]
      .map(([k, l]) => `<button role="tab" aria-selected="${sideTab === k}" class="${sideTab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('');
    $$('#sideTabs [data-tab]').forEach((b) => (b.onclick = () => { sideTab = b.dataset.tab; paintSide(); }));
    const el = $('#sideBody');
    if (sideTab === 'understand') {
      const U = P.understanding;
      el.innerHTML = !U ? `<div class="und"><p class="muted">Your editor watches and listens to the whole recording before it edits. What it understood shows up here.</p></div>` : `<div class="und">
        <p>${esc(U.summary)}</p>
        <div class="tags">${[U.video_type, U.tone, U.audience].filter(Boolean).map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>
        ${plan?.notes ? `<p class="muted" style="font-size:13px"><b style="color:var(--text);font-weight:600">Editor's approach:</b> ${esc(plan.notes)}</p>` : ''}
        ${(U.sections || []).length ? `<div><span class="eyebrow">Sections</span><div class="secs">${U.sections.map((s) => `<div class="sec" data-seek="${s.start}"><span class="mono">${fmtShort(s.start)}–${fmtShort(s.end)}</span><span><b style="font-weight:600">${esc(s.label)}</b> <span class="muted">${esc(s.on_screen || '')}</span></span></div>`).join('')}</div></div>` : ''}
        ${(U.key_moments || []).length ? `<div><span class="eyebrow">Must-see moments</span><p class="muted" style="font-size:13px;margin-top:6px">Kept clear of full-screen overlays: ${U.key_moments.map((k) => `<a href="#" data-seek="${k.t}">${fmtShort(k.t)}</a> ${esc(k.what)}`).join(' · ')}</p></div>` : ''}
        ${(P.frames || []).length ? `<div class="frames">${P.frames.map((f) => `<img src="/files/${id}/${f.file}" data-seek="${f.t}" alt="Frame at ${fmtShort(f.t)}" loading="lazy">`).join('')}</div>` : ''}
      </div>`;
      $$('[data-seek]', el).forEach((x) => (x.onclick = (e) => { e.preventDefault(); seek(+x.dataset.seek); }));
    } else if (sideTab === 'style') {
      el.innerHTML = `<div class="und">
        <div class="field"><span>How much editing</span><div class="seg" id="sideInt">${['subtle', 'balanced', 'heavy'].map((x) => `<button data-v="${x}" class="${style.intensity === x ? 'on' : ''}">${x[0].toUpperCase() + x.slice(1)}</button>`).join('')}</div></div>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 10px">${[['removeSilence', 'Trim pauses'], ['captions', 'Captions'], ['zooms', 'Zooms'], ['broll', 'B-roll'], ['memes', 'Memes'], ['sfx', 'Sound effects'], ['music', 'Background music']].map(([k, l]) => `<label class="chk"><input type="checkbox" data-style="${k}" ${style[k] !== false && style[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>
        <label class="field"><span>Notes for your editor</span><textarea id="notes" rows="3" placeholder="e.g. keep it professional, no memes in the first minute">${esc(style.notes || '')}</textarea></label>
        <button class="primary" id="sideReplan" ${!P.understanding ? 'disabled' : ''}>Re-plan with this style</button>
        <p class="hint" style="margin:0">Captions apply right away. Everything else needs a re-plan.</p></div>`;
      $$('#sideInt button').forEach((b) => (b.onclick = () => { style.intensity = b.dataset.v; paintSide(); paintHead(); }));
      $$('[data-style]', el).forEach((c) => (c.onchange = () => { style[c.dataset.style] = c.checked; if (c.dataset.style === 'captions') { savePlan(); paintTimeline(); updatePreview(); } }));
      $('#notes').oninput = (e) => { style.notes = e.target.value; };
      $('#sideReplan').onclick = replan;
    } else {
      if (!plan) { el.innerHTML = `<div class="und"><p class="muted">The edit shows up here once your editor has watched the video.</p></div>`; return; }
      const rows = [];
      const autos = all('cuts').filter((c) => c.auto);
      if (autos.length) rows.push({ t: autos[0].start, pauses: true, n: autos.length, secs: autos.reduce((a, c) => a + c.end - c.start, 0), on: autos.some(on) });
      for (const k of ['cuts', 'zooms', 'broll', 'memes', 'texts', 'sfx']) for (const it of all(k)) if (!it.auto) rows.push({ k, it, t: it.start ?? it.t });
      rows.sort((a, b) => a.t - b.t);
      el.innerHTML = rows.map((r) => r.pauses
        ? `<div class="edit ${r.on ? '' : 'off'}" data-pauses><span class="t">${fmtShort(r.t)}</span><span class="b"><span><span class="k k-cuts">Pauses</span><span style="font-weight:500">${r.n} silences trimmed</span></span><span class="why">${r.secs.toFixed(1)} s of dead air, word boundaries kept.</span></span><input type="checkbox" aria-label="Use this edit" data-tog ${r.on ? 'checked' : ''}></div>`
        : `<div class="edit ${on(r.it) ? '' : 'off'} ${sel?.id === r.it.id ? 'sel' : ''}" data-k="${r.k}" data-id="${r.it.id}"><span class="t">${fmtShort(r.t)}</span><span class="b"><span><span class="k k-${r.k}">${kindLabel(r.k, r.it)}</span><span style="font-weight:500">${esc(titleOf(r.k, r.it))}</span></span>
            <span class="why">${esc(r.it.reason || (r.it.manual ? 'Added by you' : ''))}${r.it.asset ? ` <span class="faint">· ${esc(r.it.asset.provider)}</span>` : (['broll', 'memes', 'sfx'].includes(r.k) ? ' <span class="bad">· no media found</span>' : '')}</span></span>
            <input type="checkbox" aria-label="Use this edit" data-tog ${on(r.it) ? 'checked' : ''}></div>`).join('') || '<div class="und"><p class="muted">No edits. Ask the editor for some, or add your own on the timeline.</p></div>';
    }
  }
  $('#sideBody').addEventListener('click', (e) => {
    const row = e.target.closest('.edit'); if (!row) return;
    if (e.target.matches('[data-tog]')) {
      commit();
      if (row.hasAttribute('data-pauses')) { const v = e.target.checked; all('cuts').forEach((c) => { if (c.auto) c.enabled = v; }); }
      else { const it = findIt(row.dataset.k, row.dataset.id); it.enabled = e.target.checked; it.manual = true; }
      changed(); paintInspector(); return;
    }
    if (row.hasAttribute('data-pauses')) return;
    const it = findIt(row.dataset.k, row.dataset.id); sel = { k: row.dataset.k, id: it.id };
    if (mode === 'export') { mode = 'edit'; setSrc(); }
    seek(Math.max(0, (it.start ?? it.t) - 0.3)); paintSide(); paintTimeline(); paintInspector(); scrollToSel();
  });

  // ---------- chat
  function paintChat() {
    const msgs = P.chat || [], busy = P.job?.status === 'running' && P.job.kind === 'revise';
    const lastAi = msgs.map((m) => m.role).lastIndexOf('ai');
    $('#msgs').innerHTML = (msgs.length ? '' : `<p class="muted" style="margin:0;font-size:13px">${plan ? 'Tell your editor what to change. It knows the whole video, so you can say things like “zoom in when I open the terminal”.' : 'You can chat once the first edit is ready.'}</p>`)
      + msgs.map((m, i) => m.role === 'user' ? `<div class="msg user">${esc(m.text)}</div>`
        : `<div class="msg ai"><span>${esc(m.text)}</span>${i === lastAi && chatUndo ? '<div class="chg"><span class="grow">Updated the edit</span><button class="ghost sm" id="chatUndo" style="color:var(--accent-text);font-weight:600">Undo</button></div>' : ''}</div>`).join('')
      + (busy ? `<div class="typing"><i></i><i></i><i></i>${esc(P.job.step || 'Thinking')}…</div>` : '');
    $('#chatUndo') && ($('#chatUndo').onclick = () => { commit(); plan = JSON.parse(chatUndo); chatUndo = null; norm(); changed(); paintChat(); paintInspector(); toast('Change undone'); });
    const m = $('#msgs'); m.scrollTop = m.scrollHeight;
    const dis = !plan || P.job?.status === 'running';
    $('#ask').disabled = dis; $$('#chatForm button, .chips button').forEach((b) => (b.disabled = dis));
  }
  const sendChat = (text) => { text = text.trim(); if (!text || !plan) return; chatUndo = snapshot(); (P.chat ||= []).push({ role: 'user', text }); $('#ask').value = ''; runJob(`/api/projects/${id}/revise`, { instruction: text, plan, style }); paintChat(); };
  $('#chatForm').onsubmit = (e) => { e.preventDefault(); sendChat($('#ask').value); };
  $('#ask').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat($('#ask').value); } };
  $$('[data-chip]').forEach((b) => (b.onclick = () => sendChat(b.dataset.chip)));

  // ---------- timeline
  function paintTimeline() {
    $('#tlNames').innerHTML = TRACKS.map((t) => `<div><button class="${hidden.has(t.k) ? 'hid' : ''}" data-hide="${t.k}" aria-label="${hidden.has(t.k) ? 'Show' : 'Hide'} ${t.name} track" aria-pressed="${hidden.has(t.k)}">${svg(I.eye, 14)}</button>${t.name}</div>`).join('');
    $$('[data-hide]').forEach((b) => (b.onclick = () => { const k = b.dataset.hide; hidden.has(k) ? hidden.delete(k) : hidden.add(k); paintTimeline(); }));
    inner.style.width = zoomLvl * 100 + '%';
    if (!D()) { inner.innerHTML = '<p class="muted" style="padding:20px">Preparing the video…</p>'; return; }
    const W = inner.clientWidth || 800, steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => (W / (D() / s)) >= 70) || 600;
    let ticks = ''; for (let t = 0; t <= D(); t += step) ticks += `<span style="left:${pct(t)}%">${fmtShort(t)}</span>`;
    const blk = (k, it, cls, label) => {
      const isSel = sel?.id === it.id, rng = KIND[k].range;
      return rng ? `<div class="blk ${cls} ${on(it) ? '' : 'off'} ${isSel ? 'sel' : ''}" data-k="${k}" data-id="${it.id}" style="left:${pct(it.start)}%;width:${Math.max(0.1, pct(it.end - it.start))}%" title="${esc(it.reason || label)}"><span class="h l"></span>${esc(label)}<span class="h r"></span></div>`
        : `<div class="blk pt ${cls} ${on(it) ? '' : 'off'} ${isSel ? 'sel' : ''}" data-k="${k}" data-id="${it.id}" style="left:calc(${pct(it.t)}% - 4px)" title="${esc(label)}"></div>`;
    };
    const lanes = {
      video: segments().map(([s, e], i) => `<div class="blk b-seg ${sel?.k === 'seg' && Math.abs(sel.s - s) < 0.01 ? 'sel' : ''}" data-k="seg" data-s="${s}" data-e="${e}" style="left:${pct(s)}%;width:${pct(e - s)}%;cursor:pointer" title="${fmt(s)}–${fmt(e)}">${i === 0 && pct(e - s) > 6 ? 'Recording' : ''}</div>`).join('')
        + all('cuts').map((c) => blk('cuts', c, 'b-cut', c.auto ? '' : 'Cut')).join(''),
      texts: all('texts').map((x) => blk('texts', x, 'b-text', x.text)).join(''),
      media: all('broll').map((b) => blk('broll', b, 'b-broll', b.query)).join('') + all('memes').map((m) => blk('memes', m, 'b-meme', titleOf('memes', m))).join(''),
      zooms: all('zooms').map((z) => blk('zooms', z, 'b-zoom', `${(+z.scale || 1.5).toFixed(1)}×`)).join(''),
      caps: words().map((w) => `<i class="word" style="left:${pct(w.s)}%;width:${Math.max(0.05, pct(w.e - w.s))}%"></i>`).join('')
        + `<div class="blk b-cap ${style.captions === false ? 'off' : ''} ${sel?.k === 'caps' ? 'sel' : ''}" data-k="caps" style="left:0;width:100%;background:transparent;cursor:pointer">${style.captions === false ? 'Captions off' : 'Word-by-word captions'}</div>`,
      sfx: all('sfx').map((s) => blk('sfx', s, 'b-sfx', s.query)).join(''),
    };
    inner.innerHTML = `<div class="ruler" id="ruler">${ticks}</div><div class="lanes">${TRACKS.map((t) => `<div class="lane ${hidden.has(t.k) ? 'hid' : ''}" data-lane="${t.k}">${lanes[t.k] || ''}</div>`).join('')}</div><div class="phd" id="phd"></div>`;
    updateClock();
  }
  const scrollToSel = () => { const b = inner.querySelector('.blk.sel'); if (b) b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); };
  inner.addEventListener('pointerdown', (e) => {
    if (!D()) return;
    const r = inner.getBoundingClientRect(), toT = (x) => ((x - r.left) / r.width) * D();
    const b = e.target.closest('.blk');
    if (mode === 'export') { mode = 'edit'; setSrc(); }
    if (!b) { seek(toT(e.clientX)); const mv = (ev) => seek(toT(ev.clientX)); const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); }; window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); return; }
    const k = b.dataset.k;
    if (k === 'seg') { sel = { k: 'seg', s: +b.dataset.s, e: +b.dataset.e }; seek(toT(e.clientX)); paintTimeline(); paintInspector(); return; }
    if (k === 'caps') { sel = { k: 'caps' }; seek(toT(e.clientX)); paintTimeline(); paintInspector(); return; }
    const it = findIt(k, b.dataset.id); if (!it) return;
    e.preventDefault();
    sel = { k, id: it.id };
    const how = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'move';
    const o = { start: it.start, end: it.end, t: it.t }, x0 = e.clientX; let moved = false; const before = snapshot();
    const mv = (ev) => {
      const dt = ((ev.clientX - x0) / r.width) * D();
      if (!moved && Math.abs(ev.clientX - x0) < 3) return; moved = true;
      if (!KIND[k].range) it.t = +clamp(snapT(o.t + dt, r.width), 0, D()).toFixed(3);
      else if (how === 'move') { const len = o.end - o.start; let s = clamp(o.start + dt, 0, D() - len); const sn = snapT(s, r.width); if (sn !== s) s = sn; else { const en = snapT(s + len, r.width); s = en - len; } it.start = +clamp(s, 0, D() - len).toFixed(3); it.end = +(it.start + len).toFixed(3); }
      else if (how === 'l') it.start = +clamp(snapT(o.start + dt, r.width), 0, it.end - 0.2).toFixed(3);
      else it.end = +clamp(snapT(o.end + dt, r.width), it.start + 0.2, D()).toFixed(3);
      it.manual = true; paintTimeline(); updatePreview();
    };
    const up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      if (moved) { history.push(before); future = []; savePlan(); paintSide(); paintHead(); }
      else seek(KIND[k].range ? Math.max(0, it.start - 0.2) : it.t - 0.2);
      paintTimeline(); paintInspector(); paintSide();
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    paintTimeline(); paintInspector();
  });
  $('#tlZoom').oninput = (e) => { zoomLvl = +e.target.value; paintTimeline(); $('#phd')?.scrollIntoView({ inline: 'center', block: 'nearest' }); };
  $('#snap').onchange = (e) => { snap = e.target.checked; };
  $('#protect').onchange = (e) => { style.protectManual = e.target.checked; savePlan(); };

  // ---------- tools
  function split() {
    if (!plan) return;
    const t = vid.currentTime, it = selItem();
    if (it && KIND[sel.k].range && t > it.start + 0.1 && t < it.end - 0.1) {
      commit(); const b = { ...JSON.parse(JSON.stringify(it)), id: uid(), start: +t.toFixed(3), manual: true };
      it.end = +t.toFixed(3); it.manual = true; plan[sel.k].push(b); sel = { k: sel.k, id: b.id };
    } else {
      if (cutsOn().some((c) => t > c.start && t < c.end)) return toast('The playhead is inside a cut');
      commit(); plan.splits.push(+t.toFixed(3)); const seg = segments().find(([s, e]) => t >= s - 0.01 && t < e); if (seg) sel = { k: 'seg', s: seg[0], e: seg[1] };
    }
    changed(); paintInspector();
  }
  function del() {
    if (!plan || !sel) return;
    if (sel.k === 'seg') { commit(); plan.cuts.push({ id: uid(), start: sel.s, end: sel.e, reason: 'Removed by you', manual: true }); sel = null; }
    else if (sel.k === 'caps') { style.captions = false; }
    else { const it = selItem(); if (!it) return; commit(); plan[sel.k] = plan[sel.k].filter((x) => x !== it); sel = null; }
    changed(); paintInspector();
  }
  function addText() {
    if (!plan) return;
    commit(); const t = vid.currentTime, x = { id: uid(), start: +t.toFixed(2), end: +Math.min(D(), t + 3).toFixed(2), text: 'Your title', position: 'top', size: 1, manual: true };
    plan.texts.push(x); sel = { k: 'texts', id: x.id }; if (mode !== 'edit') { mode = 'edit'; setSrc(); }
    changed(); paintInspector(); setTimeout(() => { const f = $('#inText'); f?.focus(); f?.select(); }, 30);
  }
  let mediaTarget = null;
  function addMedia(target = null) { if (!plan) return; mediaTarget = target; $('#mediaIn').value = ''; $('#mediaIn').click(); }
  $('#mediaIn').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    toast('Adding your file…');
    try {
      const { asset } = await upload(`/api/projects/${id}/media?name=${encodeURIComponent(f.name)}&ext=${ext}`, f);
      commit(); const t = vid.currentTime;
      if (mediaTarget) { const it = findIt(mediaTarget.k, mediaTarget.id); if (it) { it.asset = asset; it.manual = true; if (mediaTarget.k === 'broll') it.kind = asset.kind; } }
      else if (asset.kind === 'audio') { const s = { id: uid(), t: +t.toFixed(2), query: f.name.replace(/\.\w+$/, ''), asset, volume: 0.6, manual: true }; plan.sfx.push(s); sel = { k: 'sfx', id: s.id }; }
      else { const b = { id: uid(), start: +t.toFixed(2), end: +Math.min(D(), t + 4).toFixed(2), query: f.name.replace(/\.\w+$/, ''), kind: asset.kind, mode: 'pip', position: 'top-right', size: 0.36, asset, manual: true }; plan.broll.push(b); sel = { k: 'broll', id: b.id }; }
      mediaTarget = null; changed(); paintInspector();
    } catch (err) { toast(err.message); }
  };
  function undo() { if (!history.length) return toast('Nothing to undo'); future.push(snapshot()); plan = JSON.parse(history.pop()); norm(); if (sel && KIND[sel.k] && !selItem()) sel = null; changed(); paintInspector(); }
  function redo() { if (!future.length) return; history.push(snapshot()); plan = JSON.parse(future.pop()); norm(); changed(); paintInspector(); }
  const TOOLS = { split, delete: del, text: addText, media: () => addMedia(), undo, redo, select: () => { } };
  $$('[data-tool]').forEach((b) => (b.onclick = () => TOOLS[b.dataset.tool]()));
  const onKey = (e) => {
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
    if (k === ' ') { e.preventDefault(); vid.paused ? vid.play() : vid.pause(); }
    else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'b') { e.preventDefault(); split(); }
    else if (k === 'backspace' || k === 'delete') { e.preventDefault(); del(); }
    else if (!mod && k === 't') addText();
    else if (!mod && k === 'm') addMedia();
    else if (k === 'arrowleft' || k === 'arrowright') { e.preventDefault(); seek(vid.currentTime + (k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / 30)); }
    else if (k === 'escape') { sel = null; paintTimeline(); paintInspector(); paintSide(); updatePreview(); }
  };
  document.addEventListener('keydown', onKey);

  // ---------- inspector
  function paintInspector() {
    if (!plan) { insp.innerHTML = `<p class="muted" style="margin:0">Your editor is still watching the video. You can edit by hand as soon as the first edit is ready.</p>`; return; }
    if (!sel) {
      insp.innerHTML = `<h3>Edit it yourself</h3><p class="muted" style="margin:0;font-size:13px;line-height:1.55">Click anything on the timeline to change it. Drag blocks to move them, drag their edges to trim. Click the ruler to move the playhead.</p>
        <div class="hint" style="line-height:1.9"><kbd class="mono">Space</kbd> play · <kbd class="mono">⌘B</kbd> split · <kbd class="mono">⌫</kbd> delete · <kbd class="mono">T</kbd> text · <kbd class="mono">M</kbd> your media · <kbd class="mono">⌘Z</kbd> undo · <kbd class="mono">← →</kbd> one frame</div>`;
      return;
    }
    if (sel.k === 'seg') {
      insp.innerHTML = `<div class="head"><span class="sw" style="background:#27272A"></span><div><h3>Part of your recording</h3><span class="mono muted" style="font-size:12px">${fmt(sel.s)} → ${fmt(sel.e)} · ${(sel.e - sel.s).toFixed(1)} s</span></div></div>
        <p class="muted" style="margin:0;font-size:13px">Split it at the playhead to cut out just a piece, or remove the whole part.</p>
        <div class="row"><button data-a="split">Split at playhead</button><button class="danger" data-a="remove">Remove this part</button></div>`;
      return;
    }
    if (sel.k === 'caps') {
      insp.innerHTML = `<div class="head"><span class="sw" style="background:var(--line)"></span><div><h3>Captions</h3><span class="muted" style="font-size:12px">Word by word, from your voice</span></div></div>
        <label class="chk"><input type="checkbox" id="capOn" ${style.captions !== false ? 'checked' : ''}> Show captions</label>
        <p class="muted" style="margin:0;font-size:13px">The current word is highlighted. Cut words never show up.</p>`;
      $('#capOn').onchange = (e) => { style.captions = e.target.checked; savePlan(); paintTimeline(); updatePreview(); };
      return;
    }
    const k = sel.k, it = selItem(); if (!it) { sel = null; return paintInspector(); }
    const a = it.asset, th = thumbOf(a);
    const media = ['broll', 'memes', 'sfx'].includes(k);
    const q = k === 'memes' && it.kind !== 'gif' ? 'template' : 'query';
    const corner = (pos, withCenter) => `<div class="field"><span>Position</span><div class="row" style="gap:10px"><div class="corners" role="group" aria-label="Corner">${['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((p) => `<button class="${(pos || '') === p ? 'on' : ''}" data-pos="${p}" aria-label="${p.replace('-', ' ')}"></button>`).join('')}</div>${withCenter ? `<button class="opt sm ${pos === 'center' || !pos ? 'on' : ''}" data-pos="center">Center</button>` : ''}</div></div>`;
    const kbg = { cuts: 'cut', zooms: 'zoom', broll: 'broll', memes: 'meme', texts: 'text', sfx: 'sfx' }[k];
    insp.innerHTML = `<div class="head"><span class="sw" style="${th ? `background-image:url('${esc(th)}')` : `background:var(--k-${kbg}-bg)`}"></span>
        <div class="grow"><h3><span class="k-${k}" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-right:6px">${kindLabel(k, it)}</span>${esc(titleOf(k, it))}</h3>
        <span class="muted" style="font-size:12px">${a ? `${esc(a.provider)}${a.credit ? ' · ' + esc(a.credit) : ''}${a.page ? ` · <a href="${esc(a.page)}" target="_blank" rel="noopener">source</a>` : ''}` : (it.manual ? 'Added by you' : 'Chosen by your editor')}</span></div>
        <label class="chk" title="Use this edit"><input type="checkbox" data-f="enabled" ${on(it) ? 'checked' : ''}><span class="sr">Use this edit</span></label></div>
      ${it.reason ? `<p class="muted" style="margin:0;font-size:13px">${esc(it.reason)}</p>` : ''}
      ${k !== 'cuts' && cutsOn().some((c) => (KIND[k].range ? c.start <= it.start + 0.05 && c.end >= it.end - 0.05 : it.t > c.start && it.t < c.end)) ? `<p class="bad" style="margin:0;font-size:13px">This sits inside a part that gets cut, so it won't be in the export. Move it, or turn that cut off.</p>` : ''}
      ${KIND[k].range ? `<div class="two"><label class="field"><span>Starts at</span><input type="text" class="mono" data-f="start" value="${fmt(it.start)}"></label><label class="field"><span>Length</span><input type="text" class="mono" data-f="len" value="${(it.end - it.start).toFixed(1)} s"></label></div>`
        : `<label class="field"><span>Plays at</span><input type="text" class="mono" data-f="t" value="${fmt(it.t)}"></label>`}
      ${k === 'zooms' ? `<label class="field"><span>Zoom · ${(+it.scale || 1.5).toFixed(2)}×</span><input type="range" min="1.1" max="2.5" step="0.05" value="${it.scale || 1.5}" data-f="scale"></label>` : ''}
      ${k === 'texts' ? `<label class="field"><span>Text</span><input type="text" id="inText" data-f="text" value="${esc(it.text)}"></label>
        <div class="field"><span>Position</span><div class="three">${['top', 'middle', 'bottom'].map((p) => `<button class="opt ${(it.position || 'top') === p ? 'on' : ''}" data-tpos="${p}">${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}</div></div>
        <label class="field"><span>Size · ${Math.round((it.size || 1) * 100)}%</span><input type="range" min="0.5" max="2" step="0.05" value="${it.size || 1}" data-f="size"></label>` : ''}
      ${k === 'broll' ? `<div class="field"><span>Layout</span><div class="two"><button class="opt ${it.mode !== 'pip' ? 'on' : ''}" data-mode="full">Full screen</button><button class="opt ${it.mode === 'pip' ? 'on' : ''}" data-mode="pip">Corner</button></div></div>
        ${it.mode === 'pip' ? `${corner(it.position || 'top-right')}<label class="field"><span>Size · ${Math.round((it.size || 0.36) * 100)}%</span><input type="range" min="0.15" max="0.6" step="0.01" value="${it.size || 0.36}" data-f="size"></label>` : ''}` : ''}
      ${k === 'memes' ? `${corner(it.position || 'center', true)}<label class="field"><span>Size · ${Math.round((it.size || 0.42) * 100)}%</span><input type="range" min="0.2" max="0.7" step="0.01" value="${it.size || 0.42}" data-f="size"></label>
        ${it.kind !== 'gif' ? `<div class="two"><label class="field"><span>Top text</span><input type="text" data-f="top_text" value="${esc(it.top_text || '')}"></label><label class="field"><span>Bottom text</span><input type="text" data-f="bottom_text" value="${esc(it.bottom_text || '')}"></label></div>` : ''}` : ''}
      ${['broll', 'memes', 'texts'].includes(k) ? `<label class="field"><span>Fade in and out · ${(it.fade ?? 0.12).toFixed(2)} s</span><input type="range" min="0" max="1" step="0.02" value="${it.fade ?? 0.12}" data-f="fade"></label>` : ''}
      ${k === 'sfx' ? `<label class="field"><span>Volume · ${Math.round((it.volume ?? 0.5) * 100)}%</span><input type="range" min="0" max="1" step="0.05" value="${it.volume ?? 0.5}" data-f="volume"></label>${a ? `<audio controls preload="none" src="${a.local ? esc(a.url) : '/api/proxy?url=' + encodeURIComponent(a.url)}" style="width:100%;height:32px"></audio>` : ''}` : ''}
      ${media ? `<div class="field"><span>Replace with real media</span><div class="row" style="gap:6px;flex-wrap:nowrap"><input type="text" id="q" value="${esc(it[q] || it.query || '')}" aria-label="Search for media"><button class="sm" data-a="search">Search</button></div></div>
        ${it.candidates?.length ? `<div class="cands">${it.candidates.slice(0, 9).map((c, i) => k === 'sfx' ? `<button class="cand audio ${a && c.url === a.url ? 'on' : ''}" data-pick="${i}" title="${esc(c.title)}">${esc(c.title)}${c.duration ? ` · ${(+c.duration).toFixed(1)}s` : ''}</button>`
          : `<button class="cand ${a && c.url === a.url ? 'on' : ''}" data-pick="${i}" style="background-image:url('${esc(c.thumb || '')}')" title="${esc(c.provider + ': ' + (c.title || ''))}" aria-label="${esc(c.provider + ': ' + (c.title || ''))}"><span>${c.kind === 'video' ? '▶ ' : ''}${esc(c.provider)}</span></button>`).join('')}</div>` : ''}
        <button class="sm" data-a="own" style="align-self:flex-start">Use my own file…</button>` : ''}
      <div class="row" style="margin-top:auto;gap:8px"><button class="grow" data-a="dup">Duplicate</button><button class="grow danger" data-a="del">Remove</button></div>`;
  }
  insp.addEventListener('pointerdown', () => { if (plan && !pending) pending = snapshot(); }, true);
  insp.addEventListener('focusin', () => { if (plan && !pending) pending = snapshot(); });
  const flush = () => { if (pending && pending !== snapshot()) { history.push(pending); future = []; } pending = null; };
  insp.addEventListener('input', (e) => {
    const it = selItem(); const f = e.target.dataset.f; if (!it || !f || e.target.type !== 'range') return;
    it[f] = +e.target.value; it.manual = true;
    const lab = e.target.closest('.field')?.querySelector('span');
    if (lab) lab.textContent = lab.textContent.replace(/·.*$/, '· ' + (f === 'scale' ? (+e.target.value).toFixed(2) + '×' : f === 'fade' ? (+e.target.value).toFixed(2) + ' s' : Math.round(e.target.value * 100) + '%'));
    updatePreview(); if (f === 'scale') paintTimeline();
  });
  insp.addEventListener('change', (e) => {
    const it = selItem(); const f = e.target.dataset.f; if (!it || !f) return;
    const v = e.target.value;
    if (f === 'enabled') it.enabled = e.target.checked;
    else if (f === 'start') { const s = parseT(v); if (isFinite(s)) { const len = it.end - it.start; it.start = clamp(s, 0, D() - 0.2); it.end = Math.min(D(), it.start + len); } }
    else if (f === 'len') { const l = parseT(v); if (isFinite(l) && l > 0.1) it.end = Math.min(D(), it.start + l); }
    else if (f === 't') { const t = parseT(v); if (isFinite(t)) it.t = clamp(t, 0, D()); }
    else if (e.target.type === 'range') it[f] = +v;
    else { it[f] = v; if (f === 'template') it.query = v; }
    it.manual = true; flush(); changed(); if (!['text', 'top_text', 'bottom_text'].includes(f)) paintInspector();
  });
  insp.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset;
    if (sel?.k === 'seg') { if (d.a === 'split') split(); if (d.a === 'remove') del(); return; }
    const it = selItem(); if (!it) return;
    if (d.pos) { it.position = d.pos; }
    else if (d.tpos) { it.position = d.tpos; }
    else if (d.mode) { it.mode = d.mode; if (d.mode === 'pip') { it.position ||= 'top-right'; it.size ||= 0.36; } }
    else if (d.pick != null) { it.asset = it.candidates[+d.pick]; if (sel.k === 'broll') it.kind = it.asset.kind; }
    else if (d.a === 'search') {
      const qv = $('#q').value.trim(); if (!qv) return;
      t.disabled = true; t.textContent = '…';
      const type = sel.k === 'broll' ? 'broll' : sel.k === 'memes' ? (it.kind === 'gif' ? 'gif' : 'meme') : 'sfx';
      try { const c = await api(`/api/search?type=${type}&q=${encodeURIComponent(qv)}`); if (!pending) pending = snapshot(); it.candidates = c; if (c[0]) it.asset = c[0]; if (sel.k === 'memes' && it.kind !== 'gif') it.template = qv; it.query = qv; if (!c.length) toast('Nothing found — try simpler words'); } catch (err) { toast(err.message); }
    }
    else if (d.a === 'own') { pending = null; addMedia({ k: sel.k, id: it.id }); return; }
    else if (d.a === 'dup') { pending = null; commit(); const c = { ...JSON.parse(JSON.stringify(it)), id: uid(), manual: true }; if (KIND[sel.k].range) { const len = it.end - it.start; c.start = Math.min(D() - len, it.end + 0.1); c.end = c.start + len; } else c.t = Math.min(D(), it.t + 1); plan[sel.k].push(c); sel = { k: sel.k, id: c.id }; changed(); paintInspector(); return; }
    else if (d.a === 'del') { pending = null; del(); return; }
    else return;
    it.manual = true; flush(); changed(); paintInspector();
  });

  // ---------- header actions
  $$('#intensity button').forEach((b) => (b.onclick = () => { style.intensity = b.dataset.v; paintHead(); if (sideTab === 'style') paintSide(); }));
  function replan() { if (!P.understanding) return; chatUndo = snapshot(); runJob(`/api/projects/${id}/plan`, { style }); }
  $('#replan').onclick = replan;
  $('#delP').onclick = async () => { if (confirm('Delete this project and all its files? This cannot be undone.')) { await api(`/api/projects/${id}`, { method: 'DELETE' }); location.hash = '#/projects'; } };
  $('#exportBtn').onclick = async () => {
    const btn = $('#exportBtn'); btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      clearTimeout(saveT);
      await api(`/api/projects/${id}/plan`, { method: 'PUT', body: { plan, style } });
      const tl = await api(`/api/projects/${id}/timeline`, { method: 'POST', body: { plan } });
      const captions = style.captions !== false && tl.captions.length ? await renderCaptions(tl, (p) => (btn.textContent = `Captions ${Math.round(p * 100)}%`)) : null;
      const images = {};
      for (const m of all('memes')) if (on(m) && m.asset?.template && (m.top_text || m.bottom_text)) { try { images[m.id] = await composeMeme(m); } catch (err) { console.warn(err); } }
      for (const x of all('texts')) if (on(x) && x.text) images[x.id] = await composeText(x, tl.W, tl.H);
      btn.textContent = 'Export';
      await runJob(`/api/projects/${id}/render`, { plan, captions, memes: images });
    } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Export'; }
  };

  async function runJob(url, body) {
    try { const { jobId } = await api(url, { method: 'POST', body }); P.job = { status: 'running', log: [], progress: 0, id: jobId, kind: url.split('/').pop() }; paintJob(); paintHead(); paintChat(); poll(jobId); }
    catch (e) { toast(e.message); }
  }
  async function poll(jobId) {
    while (alive) {
      const j = await api(`/api/jobs/${jobId}`).catch(() => null);
      if (!j) break;
      P.job = j; paintJob(); if (j.kind === 'revise') paintChat();
      // Show the video and its words as soon as they exist, before the AI is done.
      if (j.status === 'running' && j.kind === 'analyze' && (!P.duration || (!P.transcript && j.progress >= 0.25))) {
        const f = await api(`/api/projects/${id}`).catch(() => null);
        if (f?.duration && (!P.duration || f.transcript)) { Object.assign(P, { duration: f.duration, width: f.width, height: f.height, transcript: f.transcript, frames: f.frames }); setSrc(); paintTimeline(); paintHead(); }
      }
      if (j.status !== 'running') {
        const fresh = await api(`/api/projects/${id}`);
        P = { ...fresh, job: j };
        plan = P.plan || null; norm(); style = { ...style, ...(P.style || {}) };
        if (sel && KIND[sel.k] && !selItem()) sel = null;
        if (j.status === 'done') {
          if (j.kind === 'render') { mode = 'export'; toast('Export finished'); }
          if (j.kind === 'revise' || j.kind === 'plan') toast('Edit updated');
          if (j.kind === 'analyze') toast('Your first edit is ready');
        } else chatUndo = null;
        paintAll();
        break;
      }
      await sleep(900);
    }
  }
  function paintAll() { paintHead(); paintJob(); setSrc(); paintSide(); paintChat(); paintTimeline(); paintInspector(); }
  const ro = new ResizeObserver(() => paintTimeline()); ro.observe($('#tlScroll'));
  cleanup = () => { alive = false; document.removeEventListener('keydown', onKey); ro.disconnect(); cancelAnimationFrame(raf); clearTimeout(saveT); vid.pause(); };

  paintAll();
  if (P.job?.status === 'running') poll(P.job.id);
  else if (P.status === 'uploaded' && !P.job) runJob(`/api/projects/${id}/analyze`, {});
}

// ------------------------------------------------------------------ captions, memes, titles (drawn here, composited by ffmpeg)
async function renderCaptions(tl, onProg) {
  const W = tl.W, H = tl.H, stripH = Math.round(H * 0.3 / 2) * 2;
  const c = document.createElement('canvas'); c.width = W; c.height = stripH;
  const g = c.getContext('2d');
  const base = Math.round(H * 0.064);
  await document.fonts.load(`900 ${base}px Inter`).catch(() => { });
  const blank = c.toDataURL('image/png');
  const frames = [];
  const draw = (words, hi) => {
    g.clearRect(0, 0, W, stripH);
    let fs = base; const txt = words.map((w) => w.w.toUpperCase());
    const measure = () => { g.font = `900 ${fs}px Inter, "Arial Black", sans-serif`; return txt.reduce((a, t) => a + g.measureText(t).width, 0) + g.measureText(' ').width * (txt.length - 1); };
    let total = measure(); while (total > W * 0.88 && fs > 12) { fs -= 2; total = measure(); }
    let x = (W - total) / 2; const y = stripH * 0.52;
    g.textBaseline = 'middle'; g.lineJoin = 'round'; g.miterLimit = 2;
    txt.forEach((t, i) => {
      const w = g.measureText(t).width;
      g.lineWidth = fs * 0.2; g.strokeStyle = 'rgba(0,0,0,.95)'; g.strokeText(t, x, y);
      g.fillStyle = i === hi ? '#C8FF3D' : '#FFFFFF'; g.fillText(t, x, y);
      x += w + g.measureText(' ').width;
    });
    return c.toDataURL('image/png');
  };
  const n = tl.captions.reduce((a, ch) => a + ch.words.length, 0); let done = 0;
  for (const ch of tl.captions) {
    ch.words.forEach((w, i) => {
      const s = i === 0 ? ch.start : w.s;
      const e = i === ch.words.length - 1 ? ch.end : ch.words[i + 1].s;
      if (e - s > 0.01) frames.push({ s, e, data: draw(ch.words, i) });
      done++;
    });
    onProg?.(done / n);
    await sleep(0);
  }
  return { stripH, blank, frames };
}

function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
async function composeMeme(m) {
  const img = await loadImg('/api/proxy?url=' + encodeURIComponent(m.asset.url));
  const s = Math.min(1, 900 / img.width); const W = Math.round(img.width * s), H = Math.round(img.height * s);
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.drawImage(img, 0, 0, W, H);
  await document.fonts.load('40px Anton').catch(() => { });
  const block = (text, top) => {
    if (!text) return;
    text = text.toUpperCase(); let fs = Math.round(H * 0.11);
    const wrap = () => { g.font = `${fs}px Anton, Impact, "Arial Black", sans-serif`; const words = text.split(/\s+/); const lines = []; let l = ''; for (const w of words) { const t = l ? l + ' ' + w : w; if (g.measureText(t).width > W * 0.92 && l) { lines.push(l); l = w; } else l = t; } lines.push(l); return lines; };
    let lines = wrap(); while ((lines.length > 3 || lines.some((l) => g.measureText(l).width > W * 0.94)) && fs > 14) { fs -= 2; lines = wrap(); }
    g.textAlign = 'center'; g.textBaseline = top ? 'top' : 'bottom'; g.lineJoin = 'round'; g.lineWidth = fs * 0.14; g.strokeStyle = '#000'; g.fillStyle = '#fff';
    lines.forEach((l, i) => { const y = top ? H * 0.03 + i * fs * 1.08 : H * 0.97 - (lines.length - 1 - i) * fs * 1.08; g.strokeText(l, W / 2, y); g.fillText(l, W / 2, y); });
  };
  block(m.top_text, true); block(m.bottom_text, false);
  return c.toDataURL('image/png');
}
/** A text title as a transparent full-frame PNG, matching the live preview. */
async function composeText(x, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const fs = Math.round(W * 0.042 * (x.size || 1));
  await document.fonts.load(`800 ${fs}px Inter`).catch(() => { });
  g.font = `800 ${fs}px Inter, "Arial Black", sans-serif`;
  const words = String(x.text).split(/\s+/), lines = []; let l = '';
  for (const w of words) { const t = l ? l + ' ' + w : w; if (g.measureText(t).width > W * 0.86 && l) { lines.push(l); l = w; } else l = t; } lines.push(l);
  const lh = fs * 1.1, block = lines.length * lh;
  const top = x.position === 'middle' ? (H - block) / 2 : x.position === 'bottom' ? H * 0.68 - block : H * 0.1;
  g.textAlign = 'center'; g.textBaseline = 'top'; g.lineJoin = 'round';
  lines.forEach((ln, i) => {
    const y = top + i * lh;
    g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = fs * 0.25; g.lineWidth = fs * 0.12; g.strokeStyle = '#000'; g.strokeText(ln, W / 2, y);
    g.shadowBlur = 0; g.fillStyle = '#fff'; g.fillText(ln, W / 2, y);
  });
  return c.toDataURL('image/png');
}

// ------------------------------------------------------------------ settings
const LANGS = [['auto', 'Detect automatically'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ar', 'Arabic'], ['ru', 'Russian'], ['nl', 'Dutch'], ['tr', 'Turkish']];
async function settingsView() {
  const cfg = await api('/api/config');
  view.innerHTML = `<div class="page"><div class="set">
    <nav class="set-nav" aria-label="Settings sections">
      ${[['brain', 'Editing brain'], ['listen', 'Transcription'], ['media', 'Media sources'], ['style', 'Default style'], ['storage', 'Storage']].map(([k, l], i) => `<a href="#" data-go="${k}" class="${i ? '' : 'on'}">${l}</a>`).join('')}
      <p style="margin:16px 12px 0;font-size:12px;color:var(--mute);line-height:1.5">Everything stays on this computer. Keys are only sent to the service they belong to.</p>
    </nav>
    <div class="set-main" id="set"><div class="card sect muted">Checking your computer…</div></div></div></div>`;
  const st = await api('/api/status').catch(() => ({}));
  const get = (p) => p.split('.').reduce((o, k) => o?.[k], cfg);
  const field = (path, label, type = 'text', ph = '') => `<label class="field"><span>${label}</span><input type="${type}" data-path="${path}" value="${esc(get(path))}" placeholder="${esc(ph)}"></label>`;
  const select = (path, label, opts) => `<label class="field"><span>${label}</span><select data-path="${path}">${opts.map(([v, l]) => `<option value="${v}" ${get(path) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  const L = cfg.llm;
  const provStatus = {
    claudecode: st.claude ? ['Found on this computer', true] : ['Not installed', false],
    codex: st.codex ? ['Found on this computer', true] : ['Not installed', false],
    ollama: st.ollama ? [`Running · ${st.ollama.length} models`, true] : ['Not running', false],
    anthropic: L.anthropic.key ? ['Key added', true] : ['No key yet', false],
    openai: L.openai.key || /localhost|127\.0\.0\.1/.test(L.openai.baseUrl) ? ['Ready', true] : ['No key yet', false],
    custom: L.custom.command ? ['Set', true] : ['Not set', false],
  };
  const MEDIA = [['pexels', 'Pexels', 'Stock video', 'https://www.pexels.com/api/'], ['pixabay', 'Pixabay', 'Stock video', 'https://pixabay.com/api/docs/'], ['giphy', 'GIPHY', 'Reaction GIFs', 'https://developers.giphy.com/dashboard/'], ['freesound', 'Freesound', 'Sound effects and music', 'https://freesound.org/apiv2/apply']];
  $('#set').innerHTML = `
  <section class="card sect" id="s-brain">
    <div><h2>Editing brain</h2><p>The AI that watches your recording and plans the edit. Use one you already pay for, or run one locally for free.</p></div>
    <div class="provs" role="radiogroup" aria-label="AI provider">${Object.entries(PROVIDERS).map(([k, p]) => `<label class="prov ${L.provider === k ? 'on' : ''}"><input type="radio" name="prov" value="${k}" ${L.provider === k ? 'checked' : ''}><span><b>${p.name}</b><small>${p.sub}</small><em class="${provStatus[k][1] ? 'ok' : ''}">${provStatus[k][0]}</em></span></label>`).join('')}</div>
    <div id="provFields"></div>
    <div class="row"><button id="testBrain">Test connection</button><span class="muted" id="testOut" style="font-size:13px"></span></div>
    <label class="chk"><input type="checkbox" data-path="llm.vision" ${L.vision ? 'checked' : ''}> Let the AI look at frames from the video <span class="muted">(needs a model that can see images)</span></label>
  </section>
  <section class="card sect" id="s-listen">
    <div><h2>Transcription</h2><p>Turns your voice into word-by-word text, so cuts never land mid-word.</p></div>
    <div class="grid3">
      ${select('transcribe.provider', 'Engine', [['auto', 'Automatic (recommended)'], ['builtin', 'Built-in Whisper'], ['local', 'whisper.cpp (faster)'], ['openai', 'Whisper API (OpenAI, Groq…)'], ['none', 'None (picture only)']])}
      ${select('transcribe.builtinModel', 'Accuracy', [['tiny', 'Fast (tiny, ~40 MB)'], ['base', 'Balanced (base, ~80 MB)'], ['small', 'Best (small, ~250 MB)']])}
      ${select('transcribe.language', 'Language', LANGS)}
    </div>
    <p class="hint" style="margin:0">Built-in Whisper downloads its model once from Hugging Face, then works offline.</p>
    <details><summary>whisper.cpp models (optional)</summary>
      <p class="hint">whisper-cli ${st.whisper ? '<span class="ok">found</span>' : 'not installed. macOS: <code>brew install whisper-cpp</code> · Windows/Linux: <a href="https://github.com/ggml-org/whisper.cpp/releases" target="_blank" rel="noopener">releases</a>'}</p>
      ${(st.models || []).map((m) => `<div class="model"><input type="radio" name="wm" data-model="${m.name}" ${cfg.transcribe.localModel === m.name ? 'checked' : ''} ${m.installed ? '' : 'disabled'} aria-label="${m.name}"><span class="grow">${m.name} <span class="muted">${m.desc}</span></span>${m.installed ? '<span class="ok">installed</span>' : `<button class="sm" data-dl="${m.name}">Download</button>`}</div>`).join('')}
    </details>
    <details><summary>Whisper API settings</summary><div class="grid3" style="margin-top:10px">${field('transcribe.openai.baseUrl', 'API base URL', 'text', 'https://api.groq.com/openai/v1')}${field('transcribe.openai.key', 'API key', 'password')}${field('transcribe.openai.model', 'Model', 'text', 'whisper-1')}</div></details>
  </section>
  <section class="card sect" id="s-media">
    <div><h2>Media sources</h2><p>Where real b-roll, memes and sounds come from. Works without keys; free keys give much better results.</p></div>
    <div>${MEDIA.map(([k, n, what, url]) => `<div class="src"><span class="nm"><b>${n}</b><small>${what}</small></span>
        <label class="grow" style="min-width:200px"><span class="sr">${n} API key</span><input type="password" class="mono" data-path="media.${k}" value="${esc(cfg.media[k])}" placeholder="Paste API key"></label>
        <span class="st ${cfg.media[k] ? 'ok' : ''}">${cfg.media[k] ? 'Connected' : 'Off'}</span><a href="${url}" target="_blank" rel="noopener" style="font-size:13px;width:110px;text-decoration:none">Get a free key</a></div>`).join('')}
      ${[['Wikimedia Commons', 'Archive photos and video'], ['Imgflip and Openverse', 'Meme templates, Creative Commons media']].map(([n, w]) => `<div class="src"><span class="nm"><b>${n}</b><small>${w}</small></span><span class="grow muted" style="font-size:13px;min-width:200px">No key needed</span><span class="st ok">Always on</span><span style="width:110px"></span></div>`).join('')}</div>
  </section>
  <section class="card sect" id="s-style">
    <div><h2>Default editing style</h2><p>Used for every new recording. You can change it per video in the editor.</p></div>
    <div class="seg" id="setInt" role="group" aria-label="How much editing" style="align-self:flex-start">${['subtle', 'balanced', 'heavy'].map((x) => `<button data-v="${x}" class="${cfg.style.intensity === x ? 'on' : ''}">${x[0].toUpperCase() + x.slice(1)}</button>`).join('')}</div>
    <div class="grid4">${[['removeSilence', 'Trim pauses'], ['captions', 'Captions'], ['zooms', 'Zooms'], ['broll', 'B-roll'], ['memes', 'Memes'], ['sfx', 'Sound effects'], ['music', 'Background music']].map(([k, l]) => `<label class="chk"><input type="checkbox" data-path="style.${k}" ${cfg.style[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>
    <label class="field"><span>Notes for your editor</span><textarea data-path="style.notes" rows="3" placeholder="e.g. I make coding tutorials. Keep memes rare and nerdy.">${esc(cfg.style.notes)}</textarea></label>
  </section>
  <section class="card sect" id="s-storage" style="flex-direction:row;align-items:center;flex-wrap:wrap">
    <span style="display:flex;flex-direction:column;gap:2px"><b>Storage</b><span class="muted" style="font-size:13px" id="storeInfo">Measuring…</span></span>
    <button style="margin-left:auto" id="reveal">Show in ${/Mac/.test(navigator.platform) ? 'Finder' : 'folder'}</button>
  </section>
  <div class="row" style="justify-content:flex-end"><span class="muted" style="font-size:12px">ffmpeg ${st.ffmpeg?.version ? `${st.ffmpeg.bundled ? 'built in' : 'yours'} (v${st.ffmpeg.version})` : '<span class="bad">missing</span>'}</span><button class="primary" id="saveCfg">Save settings</button></div>`;

  let prov = L.provider;
  const provFields = () => {
    const f = {
      anthropic: `<div class="grid2">${field('llm.anthropic.key', 'Anthropic API key', 'password', 'sk-ant-…')}${field('llm.anthropic.model', 'Model', 'text', 'claude-sonnet-5-5')}</div>`,
      openai: `<div class="grid3">${field('llm.openai.baseUrl', 'Base URL', 'text', 'https://api.openai.com/v1')}${field('llm.openai.key', 'API key', 'password')}${field('llm.openai.model', 'Model', 'text', 'gpt-4o')}</div><p class="hint" style="margin:0">Works with OpenAI, OpenRouter (<code>https://openrouter.ai/api/v1</code>), Groq, Together, and local LM Studio (<code>http://localhost:1234/v1</code>).</p>`,
      ollama: `<div class="grid2">${field('llm.ollama.url', 'Ollama URL')}${field('llm.ollama.model', 'Model (one that can see images, e.g. qwen2.5vl)')}</div><p class="hint" style="margin:0">${st.ollama?.length ? `Installed: ${st.ollama.map(esc).join(', ')}` : 'Install from <a href="https://ollama.com" target="_blank" rel="noopener">ollama.com</a>, then run <code>ollama pull qwen2.5vl</code>.'}</p>`,
      claudecode: `<div class="grid2">${field('llm.claudecode.model', 'Model (optional)', 'text', 'claude-sonnet-5-5')}</div><p class="hint" style="margin:0">Runs <code>claude -p</code> on this computer with your logged-in Claude account. No API key needed.${st.claude ? '' : ' Install: <code>npm i -g @anthropic-ai/claude-code</code>, then run <code>claude</code> once to log in.'}</p>`,
      codex: `<div class="grid2">${field('llm.codex.model', 'Model (optional)')}</div><p class="hint" style="margin:0">Runs <code>codex exec</code> with your logged-in ChatGPT account.${st.codex ? '' : ' Install: <code>npm i -g @openai/codex</code>, then run <code>codex</code> once to log in.'}</p>`,
      custom: `${field('llm.custom.command', 'Command (the prompt goes to stdin, the answer is read from stdout)', 'text', 'gemini -p')}<p class="hint" style="margin:0">Paths to video frames are listed in the prompt.</p>`,
    };
    $('#provFields').innerHTML = f[prov];
  };
  provFields();
  $$('input[name="prov"]').forEach((r) => (r.onchange = () => { collect(); prov = r.value; cfg.llm.provider = prov; $$('.prov').forEach((x) => x.classList.toggle('on', x.contains(r))); provFields(); }));
  $$('#setInt button').forEach((b) => (b.onclick = () => { cfg.style.intensity = b.dataset.v; $$('#setInt button').forEach((x) => x.classList.toggle('on', x === b)); }));
  $$('[data-dl]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    const { jobId } = await api('/api/models/download', { method: 'POST', body: { name: b.dataset.dl } });
    for (; ;) { const j = await api(`/api/jobs/${jobId}`); b.textContent = `${Math.round(j.progress * 100)}%`; if (j.status !== 'running') { if (j.status === 'error') toast(j.error); else { cfg.transcribe.localModel = b.dataset.dl; collect(); await api('/api/config', { method: 'PUT', body: cfg }); } return settingsView(); } await sleep(700); }
  }));
  function collect() {
    $$('[data-path]').forEach((el) => {
      const keys = el.dataset.path.split('.'); let o = cfg; keys.slice(0, -1).forEach((k) => (o = o[k]));
      o[keys.at(-1)] = el.type === 'checkbox' ? el.checked : el.value;
    });
    const m = document.querySelector('[data-model]:checked'); if (m) cfg.transcribe.localModel = m.dataset.model;
    cfg.llm.provider = prov;
  }
  $('#saveCfg').onclick = async () => { collect(); await api('/api/config', { method: 'PUT', body: cfg }); await loadCfg(); toast('Saved'); };
  $('#testBrain').onclick = async () => {
    collect(); await api('/api/config', { method: 'PUT', body: cfg }); await loadCfg();
    const out = $('#testOut'); out.textContent = `Asking ${PROVIDERS[prov].name}…`; $('#testBrain').disabled = true;
    const r = await api('/api/test-brain', { method: 'POST', body: {} }).catch((e) => ({ ok: false, error: e.message }));
    $('#testBrain').disabled = false;
    out.innerHTML = r.ok ? `<span class="ok">Connected · replied in ${(r.ms / 1000).toFixed(1)} s. Saved.</span>` : `<span class="bad">${esc(r.error || 'Unexpected reply: ' + r.reply)}</span>`;
  };
  api('/api/storage').then((s) => { $('#storeInfo').textContent = `${s.projects} project${s.projects === 1 ? '' : 's'} · ${bytes(s.bytes)} in ${s.path}`; $('#reveal').onclick = () => (NATIVE ? NATIVE.postMessage({ cmd: 'reveal', path: s.path }) : api('/api/storage/reveal', { method: 'POST', body: {} })); }).catch(() => { $('#storeInfo').textContent = ''; });
  $$('[data-go]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); $$('[data-go]').forEach((x) => x.classList.toggle('on', x === a)); $('#s-' + a.dataset.go).scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
}
