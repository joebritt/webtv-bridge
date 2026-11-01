// Emulator worker: owns the machine, paces it against wall-clock time and streams frames,
// LED state and debug-console text to the page.

import { WebTV } from '../src/machine/webtv.js';
import { OverlayDisk } from '../src/machine/ide.js';
import { createNetworkLine } from '../src/net/line.js';
import { WebTVService } from '../src/wtvsrv/service.js';
import { loadSectors, saveSectors, getKV, setKV } from './persist.js';
import { PackedDisk, isPackedDisk } from './packed-disk.js';

let m = null;
let running = false;
let turbo = false;
let lastFrame = null;
let frameDirty = false;
let frameInFlight = false;
const answers = [];
let dbgLine = '';

const post = (msg, transfer) => postMessage(msg, transfer || []);
const log = (...a) => post({ type: 'log', text: a.join(' ') });

// ---------------------------------------------------------------- disk backends

const BLOCK = 256 * 1024;

class BlockCache {
  constructor(maxBlocks) { this.map = new Map(); this.max = maxBlocks; }
  get(k) {
    const v = this.map.get(k);
    if (v) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k, v) {
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

// Reads a byte range synchronously from a File/Blob (FileReaderSync) or URL (sync XHR + Range).
function makeRangeReader(src) {
  if (src instanceof Blob) {
    const fr = new FileReaderSync();
    return { size: src.size, read: (start, len) => new Uint8Array(fr.readAsArrayBuffer(src.slice(start, start + len))) };
  }
  // URL: discover size with a 1-byte range request
  const head = new XMLHttpRequest();
  head.open('GET', src.url, false);
  head.setRequestHeader('Range', 'bytes=0-0');
  head.overrideMimeType('text/plain; charset=x-user-defined');
  head.send();
  const cr = head.getResponseHeader('Content-Range');
  const size = cr ? Number(cr.split('/')[1]) : Number(head.getResponseHeader('Content-Length'));
  return {
    size,
    read(start, len) {
      const x = new XMLHttpRequest();
      x.open('GET', src.url, false);
      x.setRequestHeader('Range', `bytes=${start}-${start + len - 1}`);
      x.overrideMimeType('text/plain; charset=x-user-defined');
      x.send();
      const s = x.responseText;
      const out = new Uint8Array(len);
      for (let i = 0; i < len && i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
      return out;
    },
  };
}

function makeDisk(src) {
  const rr = makeRangeReader(src);
  const cache = new BlockCache(256); // 64MB
  const readBlock = (b) => {
    let d = cache.get(b);
    if (!d) {
      const start = b * BLOCK;
      d = rr.read(start, Math.min(BLOCK, rr.size - start));
      cache.set(b, d);
    }
    return d;
  };
  return new OverlayDisk(rr.size, (lba, count) => {
    const out = new Uint8Array(count * 512);
    let pos = lba * 512, o = 0;
    while (o < out.length) {
      const b = Math.floor(pos / BLOCK), off = pos - b * BLOCK;
      const blk = readBlock(b);
      const n = Math.min(out.length - o, blk.length - off);
      if (n <= 0) break;
      out.set(blk.subarray(off, off + n), o);
      o += n; pos += n;
    }
    return out;
  });
}

// A packed (.wtvd) image is small: load it whole and decode sectors on demand.
async function openDisk(src) {
  let packed = null;
  if (src.bytes) packed = src.bytes;
  else if (src instanceof Blob) {
    const head = new Uint8Array(await src.slice(0, 8).arrayBuffer());
    if (isPackedDisk(head)) packed = await loadBytes(src);
  } else if (/\.wtvd(\?|$)/.test(src.url)) packed = await loadBytes(src);
  if (!packed) return makeDisk(src);
  const pd = new PackedDisk(packed);
  log(`[disk] packed image: ${(packed.length / 1048576).toFixed(1)} MB for ${(pd.size / 1048576).toFixed(0)} MB of disk`);
  return new OverlayDisk(pd.size, (lba, count) => pd.read(lba, count));
}

async function loadBytes(src) {
  if (src.bytes) return src.bytes;
  if (src instanceof Blob) return new Uint8Array(await src.arrayBuffer());
  const r = await fetch(src.url);
  if (!r.ok) throw new Error(`fetch ${src.url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

// ---------------------------------------------------------------- persistence
// Sectors the box writes and NVRAM changes are saved to IndexedDB shortly after they happen,
// so a box registered once stays registered across reloads.

let diskId = null;
let curDisk = null;
const pendingLbas = new Set();
let pendingNvram = null;
let flushTimer = 0;
let flushing = Promise.resolve();

function scheduleFlush() {
  if (!flushTimer) flushTimer = setTimeout(flush, 500);
}

function flush() {
  clearTimeout(flushTimer); flushTimer = 0;
  const disk = curDisk;
  const entries = [];
  if (disk && diskId) for (const lba of pendingLbas) entries.push([lba, disk.dirty.get(lba)]);
  pendingLbas.clear();
  const nv = pendingNvram; pendingNvram = null;
  flushing = flushing.then(async () => {
    if (entries.length) await saveSectors(diskId, entries);
    if (nv) await setKV('nvram', nv);
  }).catch((e) => log(`[persist] save failed: ${e.message}`));
  return flushing;
}

// ---------------------------------------------------------------- built-in WebTV service

// accounts registered with the built-in service, kept with the rest of the box state
const serviceStore = {
  async get(k) { try { return (await getKV(`wtvsrv:${k}`)) ?? null; } catch { return null; } },
  async set(k, v) { try { await setKV(`wtvsrv:${k}`, v); } catch (e) { log(`[wtvsrv] could not save: ${e.message}`); } },
};

const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(s); };

// Web pages for the box. The dev server's /api/fetch (same origin) fetches anything; without
// it (the single-file build) only sites that allow cross-origin requests work.
async function fetchForBox(url, { method = 'GET', headers = {}, body } = {}) {
  if (/^https?:$/.test(self.location.protocol)) {
    try {
      const r = await fetch(new URL('../api/fetch', self.location.href), {
        method: 'POST',
        headers: { 'X-WebTV-Emu': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, method, headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v)), body: body && body.length ? b64(body) : undefined }),
      });
      if (r.ok) {
        return { status: r.headers.get('X-Fetch-Status') || '200 OK', url: r.headers.get('X-Fetch-Url') || url, headers: { 'content-type': r.headers.get('content-type') }, body: new Uint8Array(await r.arrayBuffer()) };
      }
      if (r.status !== 404) throw new Error(await r.text());
    } catch (e) {
      if (!(e instanceof TypeError)) throw e; // network error: fall through to a direct fetch
    }
  }
  const r = await fetch(url, { method, body: method === 'POST' ? body : undefined });
  return { status: `${r.status} ${r.statusText || 'OK'}`, url: r.url, headers: { 'content-type': r.headers.get('content-type') }, body: new Uint8Array(await r.arrayBuffer()) };
}

// ---------------------------------------------------------------- machine

let audioPort = null;

async function start(cfg) {
  const rom = await loadBytes(cfg.rom);
  const disk = cfg.disk ? await openDisk(cfg.disk) : null;
  diskId = cfg.persist ? cfg.diskId : null;
  curDisk = disk;
  let nvram = null;
  if (cfg.persist) {
    try {
      nvram = (await getKV('nvram')) || null;
      if (disk && diskId) {
        const saved = await loadSectors(diskId);
        for (const [lba, data] of saved) disk.dirty.set(lba, data);
        if (saved.size) log(`[persist] restored ${saved.size} written sectors and ${nvram ? 'NVRAM' : 'no NVRAM'}`);
      }
    } catch (e) {
      log(`[persist] could not load saved state: ${e.message}`);
    }
    if (disk) disk.onWrite = (lba) => { if (diskId) { pendingLbas.add(lba); scheduleFlush(); } };
  }
  if (!nvram && cfg.nvram) nvram = new Uint8Array(cfg.nvram); // older builds kept it in localStorage
  m = new WebTV({ rom, disk, nvram, log });
  if (cfg.network === 'builtin') {
    // the WebTV service runs right here; other hosts (rare) go to the relay if one is set
    const service = new WebTVService({ store: serviceStore, log, fetchUrl: fetchForBox });
    m.modemLine.line = createNetworkLine({ service, relayUrl: cfg.relayUrl || null, hostMap: cfg.hostMap, log });
    // the LPT modem bridge (OS builds patched for it) reaches the same network
    m.lptBridge.modem.line = createNetworkLine({ service, relayUrl: cfg.relayUrl || null, hostMap: cfg.hostMap, log });
    log('[net] modem line to the built-in WebTV service');
  } else if (cfg.relayUrl) {
    m.modemLine.line = createNetworkLine({ relayUrl: cfg.relayUrl, hostMap: cfg.hostMap, log });
    m.lptBridge.modem.line = createNetworkLine({ relayUrl: cfg.relayUrl, hostMap: cfg.hostMap, log });
    log(`[net] modem line via relay ${cfg.relayUrl}`);
  }
  m.nvram.onChange = (mem) => { if (cfg.persist) { pendingNvram = new Uint8Array(mem); scheduleFlush(); } };
  m.solo.video.onFrame = (fb) => { lastFrame = fb; frameDirty = true; };
  m.onLeds = (v) => post({ type: 'led', value: v });
  m.solo.audio.onSamples = (chunk) => {
    if (turbo || !audioPort) return;
    audBuf.push(chunk); audLen += chunk.length;
  };
  answers.length = 0;
  if (cfg.autoDiskBoot !== false) answers.push({ k: 'Disk Boot?', v: 'y', done: false });
  m.solo.debugOut = (c) => {
    if (c === 10) { post({ type: 'dbg', text: dbgLine }); dbgLine = ''; }
    else if (c !== 13) dbgLine += String.fromCharCode(c);
    for (const a of answers) {
      if (!a.done && dbgLine.includes(a.k)) {
        a.done = true;
        for (const ch of a.v) m.solo.debugInput(ch.charCodeAt(0));
      }
    }
  };
  m.onReset = () => { for (const a of answers) a.done = false; };
  post({ type: 'started', diskSize: disk ? disk.size : 0 });
  running = true;
  loop();
}

// Pacing: run in ~10ms wall-clock slices, aiming for real time (cpuHz cycles per second).
// Audio produced during a slice is sent in one message at the end of the slice.
let audBuf = [], audLen = 0;
function flushAudio() {
  if (!audLen) return;
  const out = new Float32Array(audLen);
  let o = 0;
  for (const c of audBuf) { out.set(c, o); o += c.length; }
  audBuf = []; audLen = 0;
  audioPort.postMessage(out, [out.buffer]);
}

let lastWall = 0, emuBudget = 0, statCycles = 0, statWall = 0, statStart = 0;
const chan = new MessageChannel();
chan.port1.onmessage = () => tick();
function loop() {
  lastWall = performance.now();
  statStart = lastWall; statCycles = m.cpu.cycles;
  chan.port2.postMessage(0);
}

function tick() {
  if (!running) return;
  const now = performance.now();
  const dt = Math.min(now - lastWall, 100);
  lastWall = now;
  emuBudget += dt * m.cpuHz / 1000;
  const sliceEnd = now + 12;
  // run until we've caught up with real time or used our slice
  while ((turbo || emuBudget > 0) && performance.now() < sliceEnd) {
    const n = 200000;
    const c0 = m.cpu.cycles;
    m.run(n);
    emuBudget -= (m.cpu.cycles - c0);
  }
  if (emuBudget > m.cpuHz / 10) emuBudget = m.cpuHz / 10; // don't accumulate more than 100ms of debt
  if (turbo) emuBudget = 0;
  flushAudio();
  if (frameDirty && !frameInFlight) {
    frameDirty = false;
    frameInFlight = true;
    const copy = new Uint32Array(lastFrame);
    post({ type: 'frame', buf: copy.buffer, width: 640, height: 480 }, [copy.buffer]);
  }
  if (now - statStart >= 250) { // 4 samples a second for the speed graph
    const cyc = m.cpu.cycles - statCycles;
    const secs = (now - statStart) / 1000;
    post({ type: 'stats', mips: cyc / secs / 1e6, speed: cyc / secs / m.cpuHz, pc: m.cpu.pc >>> 0, frames: m.solo.video.frameCount, cycles: m.cpu.cycles });
    statStart = now; statCycles = m.cpu.cycles;
  }
  // Behind real time: continue right away (a message, so input still gets through between
  // slices). Caught up: sleep until there is more to do.
  if (turbo || emuBudget > 0) chan.port2.postMessage(0);
  else setTimeout(() => chan.port2.postMessage(0), Math.max(1, Math.min(8, -emuBudget * 1000 / m.cpuHz)));
}

onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'start': audioPort = msg.audioPort || null; start(msg.cfg).catch((err) => post({ type: 'error', text: String(err && err.stack || err) })); break;
    case 'pause': running = false; break;
    case 'flush': flush().then(() => post({ type: 'flushed' })); break;
    case 'resume': if (m && !running) { running = true; loop(); } break;
    case 'turbo': turbo = !!msg.on; break;
    case 'reset': if (m) m.requestReset('switch'); break;
    case 'frameAck': frameInFlight = false; break;
    case 'key': {
      const ir = m && m.solo.ir;
      if (!ir) break;
      if (msg.down) ir.keyDown && ir.keyDown(msg.code); else ir.keyUp && ir.keyUp(msg.code);
      break;
    }
    case 'button': { const ir = m && m.solo.ir; if (ir && ir.pressButton) ir.pressButton(msg.name); break; }
    case 'debugInput': if (m) for (const ch of msg.text) m.solo.debugInput(ch.charCodeAt(0)); break;
  }
};
