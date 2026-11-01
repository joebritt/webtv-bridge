// Page controller: file selection, canvas presentation, input forwarding, console,
// service (minisrv / relay) control and saved box state.

import { stateSummary, clearState, saveSectors } from './persist.js';
import { osInstallSectors, osImageInfo } from '../src/machine/osinstall.js';
import { patchLptModem } from '../src/lptmodem/patch.js';
import { unpackDb, recoverSymbols } from '../src/lptmodem/sigs.js';
import { renderMarkdown } from './markdown.js';
import { initDiskBrowser } from './disk-browser.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const consoleEl = $('console');
const MAX_CONSOLE_LINES = 2000;

let worker = null;

// Single-file build (tools/build-single.mjs): code and data are embedded in the page.
const EMBED = window.WEBTV_EMBED || null;
const embedText = (id) => document.getElementById(id).textContent.trim();
const embedBytes = async (id) => new Uint8Array(await (await fetch(`data:application/octet-stream;base64,${embedText(id)}`)).arrayBuffer());
const blobUrl = (id, type) => URL.createObjectURL(new Blob([embedText(id)], { type }));
let audioNode = null;
let audioStats = null; // { underruns, bufferMs, targetMs } from the worklet, once a second

async function initAudio() {
  if (audioNode) return;
  try {
    const ac = new AudioContext({ sampleRate: 44100 });
    // embedded: a data: URL, since pages opened from file:// can't load worklets from blob: URLs
    await ac.audioWorklet.addModule(EMBED
      ? `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(embedText('embed-worklet'))))}`
      : new URL('./audio-worklet.js', import.meta.url));
    audioNode = new AudioWorkletNode(ac, 'webtv-audio', { outputChannelCount: [2], processorOptions: { sourceRate: 44100 } });
    audioNode.connect(ac.destination);
    audioNode.port.onmessage = (e) => {
      if (e.data.gap) speedHist.gap();
      else audioStats = e.data;
    };
    if (ac.state === 'suspended') await ac.resume();
  } catch (e) {
    consoleWrite(`[emu] audio unavailable: ${e.message}`, 'sys');
  }
}
let paused = false;

function store(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }
function load(key) { try { return localStorage.getItem(key); } catch { return null; } }

// ---------------------------------------------------------------- console

let pendingLines = [];
function consoleWrite(text, cls) {
  pendingLines.push([text, cls]);
}
function flushConsole() {
  if (pendingLines.length) {
    const atBottom = consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 4;
    const frag = document.createDocumentFragment();
    for (const [text, cls] of pendingLines) {
      const line = document.createElement('div');
      if (cls) line.className = cls;
      line.textContent = text;
      frag.appendChild(line);
    }
    pendingLines = [];
    consoleEl.appendChild(frag);
    while (consoleEl.childNodes.length > MAX_CONSOLE_LINES) consoleEl.removeChild(consoleEl.firstChild);
    if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
  }
  requestAnimationFrame(flushConsole);
}
requestAnimationFrame(flushConsole);

// ---------------------------------------------------------------- speed graph
// Emulation speed (fraction of real time) for the last 15s, 4 samples a second, with audio
// gaps marked, so slowdowns can be matched to what you see and hear. Hover for values.

const speedHist = {
  samples: [], // { t, v, mips, pc, audioMs, gap }
  max: 60,
  hover: -1,   // index under the mouse, or -1
  add(sample) {
    this.samples.push({ ...sample, gap: this.pendingGap || false });
    this.pendingGap = false;
    if (this.samples.length > this.max) { this.samples.shift(); if (this.hover >= 0) this.hover--; }
    drawSpeedGraph();
    updateGraphTip();
  },
  gap() { this.pendingGap = true; },
  clear() { this.samples = []; this.hover = -1; drawSpeedGraph(); updateGraphTip(); },
};

const graphGeom = () => {
  const c = $('speed-graph');
  const w = c.clientWidth, bw = w / speedHist.max;
  return { c, w, h: c.clientHeight, bw, x0: w - speedHist.samples.length * bw };
};

function drawSpeedGraph() {
  const { c, w, h, bw, x0 } = graphGeom();
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const color = (k) => css.getPropertyValue(k);
  const top = 1.25; // y range 0..125%
  const y = (v) => h - Math.min(v, top) / top * (h - 3);
  speedHist.samples.forEach((s, i) => {
    const x = x0 + i * bw;
    if (i === speedHist.hover) { g.fillStyle = color('--line'); g.fillRect(x - 0.5, 0, bw + 1, h); }
    g.fillStyle = s.v >= 0.97 ? color('--led-power') : s.v >= 0.85 ? color('--led-connect') : color('--led-message');
    const yy = y(s.v);
    g.fillRect(x, yy, bw - 0.5, h - yy);
    if (s.gap) { g.fillStyle = color('--led-message'); g.fillRect(x - 0.25, 0, bw, 4); }
  });
  g.strokeStyle = color('--muted');
  g.globalAlpha = 0.7;
  g.setLineDash([3, 3]);
  g.beginPath(); g.moveTo(0, Math.round(y(1)) + 0.5); g.lineTo(w, Math.round(y(1)) + 0.5); g.stroke();
  g.setLineDash([]); g.globalAlpha = 1;
}

function updateGraphTip() {
  const tip = $('graph-tip');
  const i = speedHist.hover;
  const s = speedHist.samples[i];
  if (!s) {
    if (i === -2) { // over the empty part of the graph
      tip.innerHTML = '<span class="muted">Emulation speed, last 15 s. Line = 100%.<br>Red ticks: audio gaps.</span>';
      tip.style.left = `${graphGeom().w / 2}px`;
      tip.hidden = false;
    } else tip.hidden = true;
    return;
  }
  const { bw, x0, w } = graphGeom();
  const ago = (performance.now() - s.t) / 1000;
  const pct = Math.round(s.v * 100);
  tip.innerHTML = `<b${pct < 97 ? ' class="bad"' : ''}>${pct}%</b> \u00b7 ${s.mips.toFixed(0)} MIPS <span class="muted">\u00b7 ${ago.toFixed(1)}s ago</span><br>`
    + `<span class="muted">pc ${s.pc.toString(16)}${s.audioMs !== null ? ` \u00b7 audio ${s.audioMs}ms` : ''}</span>`
    + (s.gap ? ' <span class="bad">\u00b7 audio gap</span>' : '');
  tip.hidden = false;
  // keep the popup inside the graph's horizontal span (it is centred on its x position)
  const half = tip.offsetWidth / 2;
  const cx = x0 + (i + 0.5) * bw;
  tip.style.left = `${Math.max(half - 40, Math.min(w + 40 - half, cx))}px`;
}

$('speed-graph').addEventListener('mousemove', (e) => {
  const { bw, x0 } = graphGeom();
  const x = e.offsetX;
  const i = Math.floor((x - x0) / bw);
  speedHist.hover = i >= 0 && i < speedHist.samples.length ? i : -2;
  drawSpeedGraph();
  updateGraphTip();
});
$('speed-graph').addEventListener('mouseleave', () => { speedHist.hover = -1; drawSpeedGraph(); updateGraphTip(); });
drawSpeedGraph();

function showStats(msg) {
  const recent = speedHist.samples.slice(-4); // ~last second
  const avg = (k) => recent.reduce((a, x) => a + x[k], 0) / recent.length;
  $('st-speed').textContent = `${Math.round(avg('v') * 100)}%`;
  $('st-mips').textContent = `${avg('mips').toFixed(0)} MIPS`;
  $('st-pc').textContent = `pc ${msg.pc.toString(16).padStart(8, '0')}`;
  $('st-audio').textContent = audioStats ? `audio ${audioStats.bufferMs}ms` : '';
  $('st-gaps').textContent = audioStats ? `${audioStats.underruns} gap${audioStats.underruns === 1 ? '' : 's'}` : '';
}

// ---------------------------------------------------------------- source selection

function wireFilePicker(selectId, inputId) {
  const sel = $(selectId), input = $(inputId);
  sel.addEventListener('change', () => { if (sel.value === 'file') input.click(); });
  input.addEventListener('change', () => {
    if (input.files[0]) {
      let opt = sel.querySelector('option[data-picked]');
      if (!opt) { opt = document.createElement('option'); opt.dataset.picked = '1'; opt.value = 'picked'; sel.insertBefore(opt, sel.firstChild); }
      opt.textContent = input.files[0].name + ' (local)';
      sel.value = 'picked';
    }
  });
}
// Relay URL: remembered per browser; default ws://localhost:8081, empty = offline
{
  const saved = load('webtv.relayUrl');
  $('relay-url').value = saved === null ? 'ws://localhost:8081' : saved;
  $('relay-url').addEventListener('change', () => store('webtv.relayUrl', $('relay-url').value.trim()));
}

if (EMBED) {
  for (const [id, name] of [['rom-src', EMBED.romName], ['disk-src', EMBED.diskName]]) {
    const sel = $(id);
    for (const o of [...sel.options]) if (o.value === 'url' || o.value === 'packed') o.remove();
    sel.insertBefore(new Option(`${name} (built in)`, 'embedded'), sel.firstChild);
    sel.value = 'embedded';
  }
}
if (EMBED) {
  $('start-all-msg').textContent = 'Boots the box and turns it on. It connects to the built-in WebTV service.';
}
// Network: built-in service (default), relay, or offline; remembered per browser
{
  const sel = $('net-mode');
  const saved = load('webtv.netMode');
  if (saved) sel.value = saved;
  const sync = () => { $('relay-row').hidden = sel.value !== 'relay'; };
  sel.addEventListener('change', () => { store('webtv.netMode', sel.value); sync(); });
  sync();
}
wireFilePicker('rom-src', 'rom-file');
wireFilePicker('disk-src', 'disk-file');

// A source is a File, { url }, { embedded: id, name } or null.
function source(selectId, inputId, urls) {
  const v = $(selectId).value;
  if (v === 'picked') return $(inputId).files[0];
  if (v === 'none') return null;
  if (v.startsWith('u:')) return { url: new URL(v.slice(2), location.href).href };
  if (v === 'embedded') return { embedded: `embed-${selectId === 'rom-src' ? 'rom' : 'disk'}`, name: EMBED[selectId === 'rom-src' ? 'romName' : 'diskName'] };
  return { url: urls[v] };
}

// What the worker can load: a File, { url } or { bytes } (embedded data, decoded here).
async function resolveSource(src) {
  if (!src || !src.embedded) return src;
  let bytes = await embedBytes(src.embedded);
  if (src.embedded === 'embed-rom') { // gzipped
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return { bytes, name: src.name };
}

// ---------------------------------------------------------------- worker

// Asks the worker to write out pending box state, then stops it.
function stopWorker() {
  const w = worker;
  worker = null;
  if (!w) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(finish, 1500);
    function finish() { clearTimeout(t); w.terminate(); resolve(); }
    w.addEventListener('message', (e) => { if (e.data.type === 'flushed') finish(); });
    w.postMessage({ type: 'pause' });
    w.postMessage({ type: 'flush' });
  });
}

// Saved box state is keyed by disk. A packed (.wtvd) or embedded copy of an image shares the
// raw image's state.
function diskIdOf(src) {
  if (!src) return null;
  if (src instanceof Blob) return `file:${src.name}:${src.size}`;
  if (src.embedded) return `/data/${src.name}.bin`;
  return new URL(src.url).pathname.replace(/\.wtvd$/, '.bin');
}

let emuCycles = 0;
const cycleWaiters = new Set();
function waitForCycles(n) {
  return new Promise((resolve) => { const w = { n, resolve }; cycleWaiters.add(w); });
}

// resolves when the box prints a debug line containing `text`
const dbgWaiters = new Set();
function waitForDbg(text, timeoutMs) {
  return new Promise((resolve) => {
    const w = { text, resolve: () => { dbgWaiters.delete(w); clearTimeout(t); resolve(true); } };
    const t = setTimeout(() => { dbgWaiters.delete(w); resolve(false); }, timeoutMs);
    dbgWaiters.add(w);
  });
}

async function start() {
  await initAudio();
  await stopWorker();
  consoleEl.textContent = '';
  speedHist.clear();
  const nv = load('webtv.nvram');
  const disk = source('disk-src', 'disk-file', {
    url: new URL('../data/debug_webtv_w200_7.bin', location.href).href,
    packed: new URL('../data/debug_webtv_w200_7.wtvd', location.href).href,
  });
  const rom = source('rom-src', 'rom-file', { url: new URL('../data/flipped_merged_boot.bin', location.href).href });
  const cfg = {
    rom: await resolveSource(rom),
    disk: await resolveSource(disk),
    diskId: diskIdOf(disk),
    persist: $('persist').checked,
    autoDiskBoot: $('auto-boot').checked,
    network: $('net-mode').value,
    relayUrl: $('net-mode').value === 'relay' ? $('relay-url').value.trim() : '',
    nvram: nv ? JSON.parse(nv) : null,
  };
  if (!cfg.rom) { consoleWrite('No boot ROM selected.', 'sys'); return; }
  worker = EMBED
    ? new Worker(blobUrl('embed-worker', 'text/javascript'))
    : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => consoleWrite(`worker error: ${e.message}`, 'sys');
  // audio goes from the worker straight to the audio thread, not through this page
  let audioPort = null;
  if (audioNode) {
    const ch = new MessageChannel();
    audioNode.port.postMessage({ port: ch.port1 }, [ch.port1]);
    audioPort = ch.port2;
  }
  worker.postMessage({ type: 'start', cfg, audioPort }, audioPort ? [audioPort] : []);
  worker.postMessage({ type: 'turbo', on: $('turbo').checked });
  $('overlay').hidden = true;
  $('pause').disabled = false; $('reset').disabled = false;
  $('start').textContent = 'Restart';
  paused = false; $('pause').textContent = 'Pause';
  canvas.focus();
}

function onWorkerMessage(e) {
  const msg = e.data;
  switch (msg.type) {
    case 'frame': {
      const img = new ImageData(new Uint8ClampedArray(msg.buf), msg.width, msg.height);
      ctx.putImageData(img, 0, 0);
      worker.postMessage({ type: 'frameAck' });
      break;
    }
    case 'dbg':
      consoleWrite(msg.text);
      for (const w of dbgWaiters) if (msg.text.includes(w.text)) w.resolve();
      break;
    case 'log': consoleWrite(msg.text, 'sys'); break;
    case 'error': consoleWrite(msg.text, 'sys'); $('overlay').hidden = false; $('overlay').textContent = msg.text; break;
    case 'started': consoleWrite(`[emu] started; disk ${msg.diskSize ? (msg.diskSize / 1048576).toFixed(0) + ' MB' : 'none'}`, 'sys'); break;
    case 'led': {
      // LED bits are active-low: bit2 power, bit1 connected, bit0 message
      $('led-power').classList.toggle('on', !(msg.value & 4));
      $('led-connect').classList.toggle('on', !(msg.value & 2));
      $('led-message').classList.toggle('on', !(msg.value & 1));
      break;
    }
    case 'stats':
      emuCycles = msg.cycles || 0;
      for (const w of cycleWaiters) if (emuCycles >= w.n) { cycleWaiters.delete(w); w.resolve(true); }
      speedHist.add({ t: performance.now(), v: msg.speed, mips: msg.mips, pc: msg.pc, audioMs: audioStats ? audioStats.bufferMs : null });
      showStats(msg);
      break;
  }
}

$('start').addEventListener('click', start);
$('pause').addEventListener('click', () => {
  if (!worker) return;
  paused = !paused;
  worker.postMessage({ type: paused ? 'pause' : 'resume' });
  $('pause').textContent = paused ? 'Resume' : 'Pause';
});
$('reset').addEventListener('click', () => worker && worker.postMessage({ type: 'reset' }));
$('turbo').addEventListener('change', (e) => worker && worker.postMessage({ type: 'turbo', on: e.target.checked }));

// ---------------------------------------------------------------- input

document.querySelectorAll('[data-btn]').forEach((b) => {
  b.addEventListener('click', () => {
    if (worker) worker.postMessage({ type: 'button', name: b.dataset.btn });
    canvas.focus();
  });
});

canvas.addEventListener('keydown', (e) => {
  if (!worker || e.metaKey) return;
  e.preventDefault();
  if (!e.repeat) worker.postMessage({ type: 'key', down: true, code: e.code });
});
canvas.addEventListener('keyup', (e) => {
  if (!worker || e.metaKey) return;
  e.preventDefault();
  worker.postMessage({ type: 'key', down: false, code: e.code });
});
canvas.addEventListener('blur', () => {
  // avoid stuck keys when focus leaves the screen
  if (worker) worker.postMessage({ type: 'key', down: false, code: '*' });
});

$('console-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!worker) return;
  const input = $('console-input');
  worker.postMessage({ type: 'debugInput', text: input.value + '\r' });
  consoleWrite('> ' + input.value, 'sys');
  input.value = '';
});

addEventListener('pagehide', () => { if (worker) worker.postMessage({ type: 'flush' }); });

// ---------------------------------------------------------------- saved box state

let eraseArmed = 0;
async function refreshState() {
  try {
    const s = await stateSummary();
    $('state-summary').textContent = s.sectors || s.nvram
      ? `Saved: ${s.sectors} changed disk sector${s.sectors === 1 ? '' : 's'} (box writes, installed OS)${s.nvram ? ', NVRAM' : ''}. Restored on every Start.`
      : 'Nothing saved yet: the next Start boots a factory-fresh box.';
  } catch (e) {
    $('state-summary').textContent = `Saved state unavailable (${e.message}).`;
  }
}
refreshState();
setInterval(refreshState, 5000);

$('persist').checked = load('webtv.persist') !== '0';
$('persist').addEventListener('change', () => store('webtv.persist', $('persist').checked ? '1' : '0'));

$('reset-state').addEventListener('click', async () => {
  const b = $('reset-state');
  if (!eraseArmed) {
    b.textContent = 'Click again to erase';
    b.classList.add('danger');
    eraseArmed = setTimeout(() => { eraseArmed = 0; b.textContent = 'Erase box state\u2026'; b.classList.remove('danger'); }, 4000);
    return;
  }
  clearTimeout(eraseArmed); eraseArmed = 0;
  b.textContent = 'Erase box state\u2026'; b.classList.remove('danger');
  if (worker) { worker.terminate(); worker = null; } // discard, don't flush
  try { localStorage.removeItem('webtv.nvram'); } catch { /* storage unavailable */ }
  await clearState();
  $('overlay').hidden = false;
  $('overlay').textContent = 'Box state erased. Press Start to boot a factory-fresh box.';
  $('start').textContent = 'Start';
  $('pause').disabled = true; $('reset').disabled = true;
  consoleWrite('[emu] box state erased', 'sys');
  refreshState();
});

// ---------------------------------------------------------------- services (tools/serve.mjs /api/services)

const API = new URL('../api/services', location.href).href;
const svcState = {};

// This window's id. Services it starts are stopped by the dev server once the window closes
// (its lease stream drops). Kept in sessionStorage so a reload keeps ownership.
const OWNER = (() => {
  let id = null;
  try { id = sessionStorage.getItem('webtv.owner'); } catch { /* storage unavailable */ }
  if (!id) {
    id = crypto.randomUUID();
    try { sessionStorage.setItem('webtv.owner', id); } catch { /* storage unavailable */ }
  }
  return id;
})();
let lease = null;
function holdLease() {
  if (lease) return;
  lease = new EventSource(`${API}/lease?owner=${OWNER}`); // reconnects by itself
}

function svcMessage(text, isErr) {
  $('svc-msg').textContent = text;
  $('svc-msg').classList.toggle('err', !!isErr);
}

async function svcPost(name, action, params = '') {
  const r = await fetch(`${API}/${name}/${action}${params}`, { method: 'POST', headers: { 'X-WebTV-Emu': '1', 'X-WebTV-Owner': OWNER } });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

function describe(name, st) {
  if (st.stopsIn) return `stops in ${Math.ceil(st.stopsIn / 1000)}s (its window closed)`;
  const who = st.owned === 'other' ? ' \u00b7 another window' : '';
  switch (st.state) {
    case 'running':
      if (name === 'relay') return `:${st.port} \u2192 ${st.opts.mode === 'direct' ? 'internet' : 'local minisrv'}${who}`;
      return `running on :${st.port}${who}`;
    case 'external': return `already running on :${st.port} (started elsewhere)`;
    case 'starting': return 'starting\u2026';
    case 'stopping': return 'stopping\u2026';
    default:
      if (!st.available) return 'not installed (services/minisrv)';
      return st.exit !== null ? `stopped (exited: ${st.exit})` : 'stopped';
  }
}

async function refreshServices() {
  let data;
  try {
    const r = await fetch(`${API}?owner=${OWNER}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.statusText);
    data = await r.json();
  } catch {
    $('services-card').hidden = true; // static hosting without tools/serve.mjs
    return;
  }
  $('services-card').hidden = false;
  holdLease();
  let anyOrphan = false;
  for (const [name, st] of Object.entries(data)) {
    svcState[name] = st;
    const row = document.querySelector(`.svc[data-svc="${name}"]`);
    if (!row) continue;
    row.dataset.state = st.state;
    row.querySelector('.svc-state').textContent = describe(name, st);
    const busy = st.state === 'starting' || st.state === 'stopping';
    const startBtn = row.querySelector('[data-act=start]');
    if (st.stopsIn) {
      startBtn.textContent = 'Keep';
      startBtn.title = 'Keep it running, owned by this window';
      startBtn.disabled = false;
      row.querySelector('[data-act=stop]').disabled = false;
      anyOrphan = true;
      continue;
    }
    startBtn.textContent = 'Start'; startBtn.title = '';
    startBtn.disabled = busy || st.state !== 'stopped' || !st.available;
    row.querySelector('[data-act=stop]').disabled = busy || st.state !== 'running';
  }
  // count down every second while services are about to stop
  clearTimeout(refreshServices.soon);
  if (anyOrphan) refreshServices.soon = setTimeout(refreshServices, 1000);
}

async function svcAction(name, action) {
  try {
    if (action === 'start' && svcState[name] && svcState[name].stopsIn) {
      await fetch(`${API}/adopt`, { method: 'POST', headers: { 'X-WebTV-Emu': '1', 'X-WebTV-Owner': OWNER } });
      svcMessage('Kept running; services now stop when this window closes.');
    } else if (action === 'start') {
      svcMessage(`Starting ${name}\u2026`);
      const p = svcPost(name, 'start', name === 'relay' ? '?mode=local' : '');
      setTimeout(refreshServices, 100);
      await p;
      // the box reaches minisrv through the relay, so bring both up together
      if (name === 'minisrv' && svcState.relay && svcState.relay.state === 'stopped') await svcPost('relay', 'start', '?mode=local');
      if (!$('relay-url').value.trim()) { $('relay-url').value = 'ws://localhost:8081'; store('webtv.relayUrl', 'ws://localhost:8081'); }
      svcMessage(name === 'minisrv'
        ? 'minisrv is up. Press Start (or Restart) and then Power: the box dials minisrv through the relay.'
        : 'Relay is up.');
    } else {
      svcMessage(`Stopping ${name}\u2026`);
      const p = svcPost(name, 'stop');
      setTimeout(refreshServices, 100);
      await p;
      svcMessage(`${name} stopped.`);
    }
  } catch (e) {
    svcMessage(`${name}: ${e.message}`, true);
  }
  refreshServices();
}

document.querySelectorAll('.svc').forEach((row) => {
  row.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => svcAction(row.dataset.svc, b.dataset.act)));
});

let logSeq = 0, logName = null;
async function pollLog() {
  if (!$('svc-log-show').checked || $('services-card').hidden) return;
  const name = $('svc-log-pick').value;
  const el = $('svc-log');
  if (name !== logName) { logName = name; logSeq = 0; el.textContent = ''; }
  try {
    const r = await fetch(`${API}/${name}/log?since=${logSeq}`, { cache: 'no-store' });
    const { lines, seq } = await r.json();
    if (seq < logSeq) { logSeq = 0; el.textContent = ''; return; }
    logSeq = seq;
    if (lines.length) {
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      el.textContent += lines.map((l) => l[1]).join('\n') + '\n';
      if (el.textContent.length > 200000) el.textContent = el.textContent.slice(-150000);
      if (atBottom) el.scrollTop = el.scrollHeight;
    }
  } catch { /* server went away */ }
}
$('svc-log-show').addEventListener('change', () => { $('svc-log').hidden = !$('svc-log-show').checked; logName = null; pollLog(); });
$('svc-log-pick').addEventListener('change', () => { logName = null; pollLog(); });

refreshServices();
setInterval(refreshServices, 2000);
setInterval(pollLog, 1000);

// ---------------------------------------------------------------- README viewer

const README_URL = new URL('../README.md', location.href);
let readmeLoaded = false;
async function openReadme() {
  const dlg = $('readme');
  if (!readmeLoaded) {
    try {
      let text;
      if (EMBED) text = embedText('embed-readme');
      else {
        const r = await fetch(README_URL, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        text = await r.text();
      }
      const body = $('readme-body');
      body.innerHTML = renderMarkdown(text);
      // links in the README are relative to the project root, not web/
      for (const a of body.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href');
        if (href.startsWith('#')) { a.removeAttribute('target'); continue; }
        if (EMBED && !/^https?:/.test(href)) { a.replaceWith(...a.childNodes); continue; } // project files aren't in the single-file build
        a.href = new URL(href, README_URL).href;
      }
      readmeLoaded = true;
    } catch (e) {
      $('readme-body').textContent = `Could not load README.md (${e.message}).`;
    }
  }
  dlg.showModal();
}
$('readme-open').addEventListener('click', openReadme);
$('readme-close').addEventListener('click', () => $('readme').close());
$('readme').addEventListener('click', (e) => { if (e.target === $('readme')) $('readme').close(); }); // backdrop

// ---------------------------------------------------------------- start everything

const BOOT_READY = 'Everything OK, waiting for user input'; // printed when the box reaches standby

async function startEverything() {
  const btn = $('start-all'), msg = (t, err) => { $('start-all-msg').textContent = t; $('start-all-msg').classList.toggle('err', !!err); };
  btn.disabled = true;
  try {
    await refreshServices();
    if ($('net-mode').value !== 'relay') {
      // built-in service (or offline): nothing to start
    } else if (!$('services-card').hidden) {
      const m = svcState.minisrv, r = svcState.relay;
      if (m && m.stopsIn || r && r.stopsIn) await svcAction('minisrv', 'start'); // keep: adopts both
      if (m && m.state === 'stopped') {
        if (!m.available) throw new Error('minisrv is not installed (services/minisrv)');
        msg('Starting minisrv and the relay\u2026');
        await svcAction('minisrv', 'start');
        await refreshServices();
        if (svcState.minisrv.state !== 'running' && svcState.minisrv.state !== 'external') throw new Error($('svc-msg').textContent);
      }
      if (svcState.relay && svcState.relay.state === 'stopped') { msg('Starting the relay\u2026'); await svcAction('relay', 'start'); }
      if (!$('relay-url').value.trim()) { $('relay-url').value = 'ws://localhost:8081'; store('webtv.relayUrl', 'ws://localhost:8081'); }
    } else if (!$('relay-url').value.trim()) {
      msg('No service control here (page not served by tools/serve.mjs); starting the box offline\u2026');
    }
    msg('Booting the box\u2026');
    // the 1997 build says when it reaches standby; later builds don't (on this port), so also
    // accept ~9 s of emulated time, which is enough for every build tried
    emuCycles = 0;
    const ready = Promise.race([waitForDbg(BOOT_READY, 90000), waitForCycles(1.5e9)]);
    await start();
    const ok = await ready;
    if (!worker) return;
    await new Promise((r) => setTimeout(r, 1500)); // let standby settle
    worker.postMessage({ type: 'button', name: 'power' });
    msg(ok ? `The box is on and dialing${$('net-mode').value === 'builtin' ? ' the built-in service' : ''}. Click the screen to use the keyboard.` : 'The box took a long time to boot; pressed Power anyway.');
    canvas.focus();
  } catch (e) {
    msg(`Could not start: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}
$('start-all').addEventListener('click', startEverything);

// ---------------------------------------------------------------- disk browser

initDiskBrowser({
  async getSource() {
    const disk = source('disk-src', 'disk-file', {
      url: new URL('../data/debug_webtv_w200_7.bin', location.href).href,
      packed: new URL('../data/debug_webtv_w200_7.wtvd', location.href).href,
    });
    const label = disk ? (disk instanceof Blob ? disk.name : disk.name || new URL(disk.url).pathname.split('/').pop()) : '';
    return { src: await resolveSource(disk), diskId: diskIdOf(disk), label };
  },
});

// ---------------------------------------------------------------- boot ROMs and OS builds

// Builds found under data/rom-collection by the dev server; suggested pairs first.
const SUGGESTED = {
  bootrom: { 'dbg-int-4m-solo-ram:2205': 'debug, Feb 1998: use with debug OS builds', 'production-nondebug:2046': 'production: use with production OS builds' },
  os: { 'daily-debug:16406': 'debug; pair with boot ROM dbg 2205', 'production-nondebug:16423': 'latest production; pair with boot ROM 2046' },
};
async function loadBuilds() {
  let b;
  try {
    const r = await fetch(new URL('../api/builds', location.href), { cache: 'no-store' });
    if (!r.ok) return;
    b = await r.json();
  } catch { return; }
  const label = (x, note) => `${x.flavor} ${x.build}${note ? ` \u2014 ${note}` : ''}`;
  const fill = (sel, items, kind, before) => {
    const sugg = items.filter((x) => SUGGESTED[kind][`${x.flavor}:${x.build}`]);
    const groups = [['Suggested', sugg], ['All builds', items]];
    for (const [title, list] of groups) {
      if (!list.length) continue;
      const g = document.createElement('optgroup');
      g.label = title;
      for (const x of list) {
        const o = new Option(label(x, title === 'Suggested' ? SUGGESTED[kind][`${x.flavor}:${x.build}`] : ''), `u:${x.url}`);
        if (x.symbols) o.dataset.symbols = x.symbols;
        g.append(o);
      }
      sel.insertBefore(g, before);
    }
  };
  fill($('rom-src'), b.bootroms, 'bootrom', $('rom-src').querySelector('option[value=file]'));
  fill($('os-pick'), b.os, 'os', $('os-pick').firstChild);
  const savedRom = load('webtv.romSrc');
  if (savedRom && [...$('rom-src').options].some((o) => o.value === savedRom)) $('rom-src').value = savedRom;
  if (b.os.length) $('os-pick').value = $('os-pick').querySelector('optgroup option').value;
}
if (!EMBED) loadBuilds();
$('rom-src').addEventListener('change', () => { if ($('rom-src').value.startsWith('u:') || $('rom-src').value === 'url') store('webtv.romSrc', $('rom-src').value); });

$('os-pick').addEventListener('change', () => { if ($('os-pick').value === 'file') $('os-file').click(); });

async function installOs() {
  const say = (t, err) => { $('os-msg').textContent = t; $('os-msg').classList.toggle('err', !!err); };
  const btn = $('os-install');
  btn.disabled = true;
  try {
    let bytes, name, symbols = null;
    const lpt = $('os-lpt').checked;
    if ($('os-pick').value === 'file') {
      const files = [...$('os-file').files];
      const f = files.find((x) => !/\.sym$/i.test(x.name));
      if (!f) { $('os-file').click(); return; }
      bytes = new Uint8Array(await f.arrayBuffer()); name = f.name;
      const s = files.find((x) => /\.sym$/i.test(x.name));
      if (s) symbols = new Uint8Array(await s.arrayBuffer());
    } else {
      const opt = $('os-pick').selectedOptions[0];
      say('Downloading the build\u2026');
      const get = async (u) => { const r = await fetch(new URL(u, location.href)); if (!r.ok) throw new Error(`HTTP ${r.status}`); return new Uint8Array(await r.arrayBuffer()); };
      bytes = await get($('os-pick').value.slice(2)); name = opt.textContent.split(' \u2014')[0];
      if (lpt && opt.dataset.symbols) symbols = await get(opt.dataset.symbols);
    }
    if (lpt) {
      let syms = symbols;
      if (!syms) { // no symbols.sym: find the names in the code by signature
        say('No symbols for this build: finding what the patch needs by signature\u2026');
        const r = await fetch(new URL('../src/lptmodem/sigdb.json', location.href));
        if (!r.ok) throw new Error(`signature database: HTTP ${r.status}`);
        syms = recoverSymbols(bytes, osImageInfo(bytes), unpackDb(await r.json()));
        for (const l of syms.report) consoleWrite(`[lpt] ${l}`, 'sys');
      }
      const r = patchLptModem(bytes, syms);
      for (const l of r.report) consoleWrite(`[lpt] ${l}`, 'sys');
      bytes = r.image; name += ' + LPT modem patch';
    }
    const disk = source('disk-src', 'disk-file', {
      url: new URL('../data/debug_webtv_w200_7.bin', location.href).href,
      packed: new URL('../data/debug_webtv_w200_7.wtvd', location.href).href,
    });
    const diskId = diskIdOf(disk);
    if (!diskId) throw new Error('pick a disk image first');
    const { info, sectors } = osInstallSectors(bytes);
    const wasRunning = !!worker;
    await stopWorker(); // the box must not be running while its disk changes
    if (wasRunning) { $('overlay').hidden = false; $('overlay').textContent = 'Stopped to install an OS build. Press Start everything.'; $('start').textContent = 'Start'; }
    await saveSectors(diskId, [...sectors]);
    // newer builds need a newer boot ROM: select the usual partner
    const pair = info.base === 0x80400000 ? null : /production/.test(name) ? 'bootrom/production-nondebug/build-2046/' : 'bootrom/dbg-int-4m-solo-ram/build-2205/';
    const romOpt = pair && [...$('rom-src').options].find((o) => decodeURIComponent(o.value).includes(pair));
    if (romOpt) { $('rom-src').value = romOpt.value; store('webtv.romSrc', romOpt.value); }
    say(`Installed ${name} (${(info.size / 1048576).toFixed(1)} MB${info.checksumOk ? '' : ', checksum does not match!'}) on this disk.${romOpt ? ` Boot ROM set to ${romOpt.textContent.split(' \u2014')[0]}.` : ' Pick a matching boot ROM above.'} Press Start everything.`, !info.checksumOk);
    consoleWrite(`[emu] installed OS build ${name} into the disk's saved state`, 'sys');
    refreshState();
  } catch (e) {
    say(`Could not install: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}
$('os-install').addEventListener('click', installOs);
$('os-lpt').checked = load('webtv.osLpt') === '1';
$('os-lpt').addEventListener('change', () => store('webtv.osLpt', $('os-lpt').checked ? '1' : '0'));
$('os-file').addEventListener('change', () => { if ($('os-file').files[0]) installOs(); });
