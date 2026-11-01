#!/usr/bin/env node
// A stock box with the bridge on its parallel port, the bridge being its own firmware: the Pico's
// C, both cores, built to WebAssembly (pico/sim; src/machine/picosim.js) and run against the
// emulated box pin by pin (WEBTV_LPT_BRIDGE.md §10.7). Through power-ups, the remote's power
// button, a crash, the bridge's menu and its web page, against the simulated radio and the
// built-in WebTV service. The OS on the disk is never patched: the bridge patches it in RAM at
// every start.
//
//   1. first power-up, bridge not set up: diagnostics, loader, WiFi setup on the TV, the OS read
//      and patched in RAM, the countdown, then the patched OS from RAM
//   2. power on, then off before it has connected (the OS reboots on power-off only while it
//      isn't connected; the patch keeps it from restarting from RAM): the OS says REBOOT; the
//      bridge catches the reset, reads and patches again and starts it without the countdown;
//      then it goes online (PARMOD)
//   3. a reset with no notice (a crash): the bridge catches the dongle probe, reads and patches
//      again
//   4. a power cycle: the countdown stopped with a key; Settings: the WTVP server typed; Start
//   5. The web page's own reach into the box while the WebTV Bridge screen is up: a screenshot
//      (the framebuffer, read through /mem, as the box's RAM has it), the WTVP server set and read back, and the
//      Box Filesystem's reads and writes (a file written into a FAT partition, found on the
//      emulated disk where it belongs, read back, deleted); the countdown holds meanwhile.
//      Then Save this OS, from the bridge's web page: what it gets must be the image on the disk
//   6. Install another OS, from the bridge's web page: onto the other slot, the select block
//      flipped, patched, started; the next power cycle boots it
//   7. Settings: Philips unticked under Remotes, Turn on by itself switched off; Start: the two
//      words in RAM as asked; the OS waits in standby until the power key, then goes online
//   8. A screenshot while the OS runs: the patched OS reads its memory for the Bridge over
//      PARMOD's control channel (peeks), and the page's code composites the SOLO's cels from it;
//      nearly every pixel must equal the emulator's own picture
//   9. Keys from the web page (POST /key, the Remote tab): in 7 the first key, stopping the
//      countdown, comes this way to the WebTV Bridge screen; with the OS running, a remote key and
//      an IR keyboard press and release go over PARMOD into the OS's IR input ring, each found
//      there with its time and taken by the OS
//
// Scenarios 1-6 run with the Bridge's defaults: Turn on by itself is on, so the OS powers on and
// dials with no power key.
//
// PAGESHOT=1 also writes DIR/bridgesim-page-*.png: the web page's tabs, in headless Chrome
// driven over its DevTools protocol (it clicks through the Screenshot and Box Filesystem tabs).
//
//   node tools/bridgesim.mjs [--rom FILE] [--tier3 [--entry-tier3]] [--os FILE] [--install FILE] [--out DIR]
//
// pico/sim must be built (`make` there). --tier3 puts the loader in the disk's tier-3 area:
// needed with a boot ROM that has no debug monitor (production 2046:
// --rom data/rom-collection/.../bootrom/production-nondebug/build-2046/_bootstraprom.o).
// The built-in service listens on 127.0.0.1's WTVP ports and the firmware's web page on
// 127.0.0.1:8080, so those must be free on 127.0.0.1. BOXLOG=1 logs everything; REBOOTDUMP=1
// logs the box CPU's caller chain whenever the OS resets itself (SafeReset).
//
// Logs each step with emulated times and writes DIR/bridgesim-*.png.
import { readFileSync, writeFileSync, openSync, readSync, fstatSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { WebTV } from '../src/machine/webtv.js';
import { OverlayDisk } from '../src/machine/ide.js';
import { osInstallSectors, osImageInfo } from '../src/machine/osinstall.js';
import { PicoSim } from '../src/machine/picosim.js';
import { imageIdentity } from '../src/stockbox/patchtable.js';
import { buildTier3, TIER3_LBA } from '../src/stockbox/tier3.js';
import { WebTVService, SERVICE_PORTS } from '../src/wtvsrv/service.js';
import { writePng } from './png.mjs';
import { WebTVDisk } from '../web/wtvdisk.js';
import { grabScreen } from '../web/boxscreen.js';
import { symbolSource } from '../src/lptmodem/patch.js';

const SELECT_LBA = 33795, SLOTS = [1027, 17411];   // the select block, the two OS slots (pico/src/sb/sb_ramboot.c)
const WEB = 'http://127.0.0.1:8080';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const R = 'data/rom-collection/artemis (Stock)/US-LC2-disk-0MB-8MB';
const out = opt('out', 'out/stockbox');
mkdirSync(out, { recursive: true });

// 16406 (daily-debug) by default: its console shows on the log. 16423 (production-nondebug)
// passes too since the modem's banner race was fixed (spec §10.8).
const osFile = opt('os', `${R}/approm/daily-debug/build-16406/_approm.o`);
const osImage = new Uint8Array(readFileSync(osFile));
const osInfo = osImageInfo(osImage);
const installFile = opt('install', `${R}/approm/production-nondebug/build-7181/_approm.o`);
const fd = openSync('data/debug_webtv_w200_7.bin', 'r');
const disk = new OverlayDisk(fstatSync(fd).size, (lba, n) => { const b = new Uint8Array(n * 512); readSync(fd, b, 0, b.length, lba * 512); return b; });
for (const [lba, d] of osInstallSectors(osImage).sectors) disk.dirty.set(lba, d);
const table = JSON.parse(gunzipSync(readFileSync('src/stockbox/patches.json.gz')));
// --tier3: the loader in the disk's tier-3 area, for a boot ROM without the debug monitor (2046)
if (args.includes('--tier3')) for (const [lba, d] of osInstallSectors(buildTier3(), [TIER3_LBA]).sectors) disk.dirty.set(lba, d);

// the built-in WebTV service where the firmware's gateway sends the box (its WTVP server)
// its clock pinned to an afternoon: the date it gives the box sets when the OS does its
// late-night reboot, and near that hour a box restarting reboots again at once
// (and it runs on emulated time, so a run doesn't depend on how fast the host is)
const START = Date.parse('2026-10-31T15:00:00Z');
let m = null;
const service = new WebTVService({ log: () => {}, now: () => new Date(START + (m ? m.cpu.cycles / m.cpuHz * 1000 : 0)) });
for (const port of SERVICE_PORTS) {
  const srv = net.createServer((sock) => {
    sock.setNoDelay(true);
    const conn = service.openConnection(port, { send: (d) => sock.write(d), close: () => sock.end() });
    sock.on('data', (d) => conn.receive(new Uint8Array(d)));
    sock.on('close', () => { conn.closed = true; });
    sock.on('error', () => {});
  });
  srv.on('error', (e) => { throw new Error(`can't serve WTVP on 127.0.0.1:${port}: ${e.code}`); });
  srv.listen(port, '127.0.0.1');
  srv.unref();
}

const log = (s) => console.log(s);
let resets = 0, ipcp = 0, diskReads = 0, dials = 0, joined = false;
const events = [];   // the bridge's notes: { at (s), what }
m = new WebTV({ rom: readFileSync(opt('rom', 'data/flipped_merged_boot.bin')), disk, log: (s) => {
  if (s.startsWith('[machine]')) { resets++; log(`[box] ${secs()} ${s.slice(10)}`); }
  else if (process.env.BOXLOG && !/^\[(led|solo|bus|audio)\]/.test(s)) log(`[box] ${secs()} ${s}`);
} });
const secs = () => (m.cpu.cycles / m.cpuHz).toFixed(2) + ' s';
const pico = await PicoSim.create(m, { service: 'localhost', log: (s) => {
  for (const line of s.split('\n')) {
    if (!line) continue;
    const n = line.match(/^\[bridge\] ([\d.]+) s (.*)$/);
    if (n) events.push({ at: Number(n[1]), what: n[2] });
    if (/\[modem\] dialing/.test(line)) dials++;
    if (/\[ppp\] IPCP up/.test(line)) ipcp++;
    if (/\[wifi\] joined/.test(line)) joined = true;
    if (n || /^\[(ramboot|wifi)\]|\[ppp\] IPCP up|\[modem\] dialing/.test(line) || process.env.BOXLOG) log(n ? line : `[pico] ${secs()} ${line}`);
  }
} });
// --entry-tier3: start as a production ROM must, through test 19 and the tier-3 area, even on a
// debug ROM (the console's `entry tier3`; use with --tier3)
if (args.includes('--entry-tier3')) pico.console('entry tier3\r');
const state = () => pico.state();

// the boot ROM's own OS loads (not the bridge's): reads of an OS slot while the OS runs
const ideCmd = m.ide.command.bind(m.ide);
m.ide.command = (c) => { if (c === 0x20 && state() === 'os' && SLOTS.includes(m.ide.getLba())) diskReads++; return ideCmd(c); };
// The OS has started when its DetermineBootType clears BUS_RESETCAUSE (0xac) from OS code.
let osStarts = 0;
const bus = m.solo.busWrite.bind(m.solo);
// REBOOTDUMP=1: when OS code writes BUS_RESETCAUSE (SafeReset), its pc/ra and the code addresses
// on its stack (the caller chain; symbolize with tools/symdis.mjs)
const dumpReset = () => {
  const c = m.cpu, sp = c.gprL[29] >>> 0, codes = [];
  for (let a = sp; a < sp + 0x1000 && codes.length < 40; a += 4) {
    const v = m.bus.read32(a & 0x1fffffff) >>> 0;
    if (v >= 0x80400000 && v < 0x80800000 && (v & 3) === 0) codes.push(`${(a - sp).toString(16)}:${v.toString(16)}`);
  }
  log(`[rebootdump] ${secs()} pc=${(c.curPC >>> 0).toString(16)} ra=${(c.gprL[31] >>> 0).toString(16)} a0=${(c.gprL[4] >>> 0).toString(16)} sp=${sp.toString(16)} stack ${codes.join(' ')}`);
};
m.solo.busWrite = (o, v) => {
  if (process.env.REBOOTDUMP && o === 0xa8 && (m.cpu.curPC >>> 0) >= 0x803c0000 && (m.cpu.curPC >>> 0) < 0x80800000) dumpReset(); if (o === 0xac && (m.cpu.curPC >>> 0) >= 0x803c0000 && (m.cpu.curPC >>> 0) < 0x80800000) { osStarts++; log(`[box] ${secs()} OS started`); } bus(o, v); };

const PASSWORD = 'Hello WebTV 1998';
const states = [];   // the start-up's states as they change: { at (s), state }
const step = () => {
  m.run(5e6);
  const s = state();
  if (!states.length || states.at(-1).state !== s) states.push({ at: m.cpu.cycles / m.cpuHz, state: s });
};
// the sockets (the service, the web page) run on the event loop: yield to it between slices
const tickle = () => new Promise((r) => setImmediate(r));
const runUntil = async (cond, what, max = 90) => {
  const end = m.cpu.cycles + max * m.cpuHz;
  while (!cond()) { if (m.cpu.cycles > end) throw new Error(`no ${what} by ${secs()} (bridge ${state()})`); step(); await tickle(); }
};
const runFor = async (s) => { const end = m.cpu.cycles + s * m.cpuHz; while (m.cpu.cycles < end) { step(); await tickle(); } };
// a promise settled while the box runs (the web page's requests)
const runWhile = async (p, what, max = 300) => {
  let done = false, value, error;
  p.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  await runUntil(() => done, what, max);
  if (error) throw error;
  return value;
};
const png = (name) => { const f = join(out, `bridgesim-${name}.png`); writePng(f, m.solo.video.fb, 640, 480); log(`[png] ${f} at ${secs()}`); };
const tap = (code) => { m.ir.keyDown(code); m.ir.keyUp(code); };
const at = (what) => events.findLast((e) => e.what.startsWith(what))?.at;
const press = async (...bs) => { for (const b of bs) { m.ir.pressRemote(b); await runFor(0.3); } };
const statesSince = (t) => states.filter((x) => x.at > t).map((x) => x.state);
// the OS started (it turns on by itself; with Turn on by itself off, power: the power key is
// pressed), online over PARMOD (PPP up: the firmware's only way)
const online = async (what, power = false) => {
  const n = ipcp, d = dials;
  await runFor(3);
  if (power) m.ir.pressButton('power');
  // after a start on its cold path the OS may first ask whether the box has moved ("Same
  // Place" / "Moved"): answer Same Place, as a user would
  try { await runUntil(() => dials > d, `${what}: a dial`, 12); }
  catch {
    log(`[box] ${secs()} ${what}: no dial yet; answering the OS's "Moved?" question with Same Place`);
    await press('left', 'select');
  }
  await runUntil(() => ipcp > n, `${what}: online`);
  log(`[box] ${secs()} ${what}: online over PARMOD`);
};
// the web page's Save/Install switch: X-Ready on /status ('1' while the WebTV Bridge screen is up)
const webReady = async () => (await runWhile(fetch(`${WEB}/status`), 'the status', 30)).headers.get('X-Ready');
// PAGESHOT=1: the web page as a browser shows it: headless Chrome over its DevTools protocol, the
// box running meanwhile. steps: [tab, js to run there (or null), seconds to wait, shot name]
const pageShots = async (steps) => {
  if (!process.env.PAGESHOT) return;
  const profile = join(tmpdir(), `bridgesim-chrome-${process.pid}`);
  const c = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu',
    `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', '--remote-debugging-port=0', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const wsUrl = await runWhile(new Promise((res, rej) => {
      let err = '';
      c.stderr.on('data', (d) => { err += d; const m = err.match(/DevTools listening on (ws:\S+)/); if (m) res(m[1]); });
      c.on('exit', () => rej(new Error('Chrome exited')));
    }), 'Chrome', 60);
    const port = new URL(wsUrl).port;
    const targets = await runWhile(fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()), 'Chrome', 30);
    const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await runWhile(new Promise((res) => ws.addEventListener('open', res)), 'Chrome', 30);
    let id = 0;
    const waiting = new Map();
    ws.addEventListener('message', (e) => { const msg = JSON.parse(e.data); waiting.get(msg.id)?.(msg); waiting.delete(msg.id); });
    const cdp = (method, params = {}) => runWhile(new Promise((res) => { waiting.set(++id, res); ws.send(JSON.stringify({ id, method, params })); }), method, 120);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 820, height: 1200, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: `${WEB}/` });
    // loaded: the page's script has run (slower in emulated time while the OS is online)
    for (let i = 0; ; i++) {
      await runFor(1);
      const r = await cdp('Runtime.evaluate', { expression: "typeof show === 'function' && document.readyState === 'complete'", returnByValue: true });
      if (r.result.result.value) break;
      if (i === 30) throw new Error('the page did not load');
      if (i % 10 === 9) await cdp('Page.reload');
    }
    await runFor(2);
    for (const [tab, js, wait, name] of steps) {
      await cdp('Runtime.evaluate', { expression: `show(${JSON.stringify(tab)}); ${js || ''}`, awaitPromise: true });
      await runFor(wait);
      await cdp('Emulation.setDeviceMetricsOverride', { width: 820, height: 300, deviceScaleFactor: 1, mobile: false });
      const { result } = await cdp('Runtime.evaluate', { expression: 'Math.ceil(document.body.getBoundingClientRect().bottom) + 20', returnByValue: true });
      const h = Math.min(4000, Math.max(300, result.result.value));
      await cdp('Emulation.setDeviceMetricsOverride', { width: 820, height: h, deviceScaleFactor: 1, mobile: false });
      const shot = await cdp('Page.captureScreenshot', { format: 'png' });
      const f = join(out, `bridgesim-page-${name}.png`);
      writeFileSync(f, Buffer.from(shot.result.data, 'base64'));
      log(`[png] ${f} at ${secs()}`);
      await cdp('Emulation.setDeviceMetricsOverride', { width: 820, height: 1200, deviceScaleFactor: 1, mobile: false });
    }
    ws.close();
  } catch (e) { log(`[png] no page screenshots (${e.message})`); }
  const gone = new Promise((res) => (c.exitCode !== null ? res() : c.on('exit', res)));
  c.kill('SIGKILL');
  await gone;
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { }
};
const summary = [];

// 1. first power-up
log('--- 1. power applied, bridge not set up');
await runUntil(() => state() === 'wifi', 'WiFi setup');
await runFor(2);
png('1-wifi');
await press('down', 'down', 'select');                 // Artemis WiFi
await runFor(1);
png('1-password');
m.ir.typeText(PASSWORD);
await runFor(3);
png('1-typed');
tap('Enter');
await runFor(0.4);
png('1-joining');
await runUntil(() => joined, 'join');
await runFor(1);
png('1-joined');
m.ir.pressRemote('select');                            // "Connected": continue
await runUntil(() => state() === 'loading', 'loading');
await runFor(0.1);
png('2-loading');
await runUntil(() => state() === 'countdown', 'countdown');
await runFor(0.5);
png('3-countdown');
if (!at('patched')) throw new Error('not patched');
if (await webReady() !== '1') throw new Error('the web page says Save/Install are off on the WebTV Bridge screen');
await runUntil(() => state() === 'os', 'the countdown to run out', 15);
const reads1 = diskReads;
await runUntil(() => osStarts >= 1, 'the OS');
if (diskReads !== reads1) throw new Error('the boot ROM read the OS from the disk');
if (await webReady() !== '0') throw new Error('the web page says Save/Install are on while the OS runs');
summary.push(`1. power-up: loader ${at('loader running').toFixed(1)} s; WiFi set up; OS read and patched by ${at('patched').toFixed(1)} s; started from RAM at ${at('starting the OS').toFixed(1)} s; the OS running at ${secs()}`);

// 2. on (by itself), then off with the power key before it connects: REBOOT, the bridge catches
// the reset, reads and patches again, and starts the OS at once (no countdown)
log('--- 2. power on, then off');
await runFor(10);
const offAt = m.cpu.cycles / m.cpuHz, resets2 = resets;
m.ir.pressButton('power');
// a real restart: a box reset, then the OS (the OS also clears BUS_RESETCAUSE on its way down)
await runUntil(() => resets > resets2, 'the reset after power-off', 30);
const s2 = osStarts;
await runUntil(() => osStarts > s2, 'the OS after the reboot');
if (!events.some((e) => e.at > offAt && e.what === 'the OS says it is rebooting')) throw new Error('no REBOOT from the OS');
if (statesSince(offAt).includes('countdown')) throw new Error('the bridge showed its countdown on a reboot');
await online('2');
summary.push(`2. power-off at ${offAt.toFixed(1)} s: REBOOT at ${at('the OS says it is rebooting').toFixed(1)} s; reset caught, read and patched again, started at once at ${at('starting the OS').toFixed(1)} s; online at ${secs()}`);

// 3. a reset with no notice: as a crash or a watchdog would
log('--- 3. a reset without notice (a crash)');
await runFor(3);
const crashAt = m.cpu.cycles / m.cpuHz;
m.bus.write32(0x040000a8, 4);
await runUntil(() => state() === 'countdown', 'countdown after the crash');
await runUntil(() => state() === 'os', 'the restart', 15);
const s3 = osStarts;
await runUntil(() => osStarts > s3, 'the OS after the crash');
await online('3');
summary.push(`3. reset without notice at ${crashAt.toFixed(1)} s: probe caught at ${at('the boot ROM is probing').toFixed(1)} s, read and patched again, online at ${secs()}`);

// 4. power cycle; the countdown stopped; the WTVP server set; start
log('--- 4. power cycle, settings');
await runFor(2);
const p4 = m.cpu.cycles / m.cpuHz;
m.powerCycle();
await runUntil(() => state() === 'countdown' && at('patched') > p4, 'countdown');
await press('down');                                   // stops the countdown
await press('down', 'select');                         // Settings (Start now, Settings)
await runUntil(() => state() === 'settings', 'settings');
await runFor(0.3);
png('4-settings');
await press('down', 'select');                         // WTVP server
await runFor(0.5);
png('4-server');
await press('right', 'select', 'down', 'right');       // Keyboard: the on-screen keyboard, to 's'
await runFor(0.3);
png('4-keyboard');
await press('back', 'left');                           // back to the box, its focus
m.ir.typeText('127.0.0.1');                            // replaces "localhost" (it comes up selected)
await runFor(2);
png('4-typed');
tap('Enter');
await runUntil(() => events.some((e) => e.at > p4 && e.what === 'WTVP server: 127.0.0.1'), 'the WTVP server setting', 20);
await runFor(0.5);
png('4-saved');
await press('down', 'down', 'down', 'down', 'select'); // Done (WiFi, WTVP, Remotes, Turn on by itself, Done)
await runUntil(() => state() === 'countdown', 'back to the countdown');
await runFor(0.3);
png('5-countdown-server');

// 5. the web page's own reach into the box, the WebTV Bridge screen up (the countdown stopped)
log('--- 5. the box through the web page: screenshot, WTVP server, Box Filesystem');
const get = (path, init) => runWhile(fetch(`${WEB}${path}`, init).then(async (r) => {
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).trim()}`);
  return { bytes: new Uint8Array(await r.arrayBuffer()), headers: r.headers };
}), path, 300);
if ((await runWhile(fetch(`${WEB}/status`), 'the status', 30)).headers.get('X-Box') !== '1') throw new Error('X-Box is not 1 on the WebTV Bridge screen');
// the page's Screenshot: box memory through /mem (web/boxscreen.js); on this screen a framebuffer
const readMem = async (addr, len) => (await get(`/mem?addr=0x${(addr >>> 0).toString(16)}&len=${len}`)).bytes;
const scr = await grabScreen(readMem, (phys) => 0xa0000000 + phys);   // each /mem runs the box while it waits
const sw = scr.width, sh = scr.height, sa = scr.address;
if (scr.mode !== 'framebuffer' || sw !== 560 || sh !== 420 || scr.yuyv.length !== sw * sh * 2) throw new Error(`the screenshot is ${scr.mode}, ${sw} x ${sh}, ${scr.yuyv.length} bytes`);
for (let i = 0; i < scr.yuyv.length; i += 4) {
  const w = m.bus.ram[((sa & 0x1fffffff) + i & m.bus.ramMask) >>> 2] >>> 0;
  const v = ((scr.yuyv[i] << 24) | (scr.yuyv[i + 1] << 16) | (scr.yuyv[i + 2] << 8) | scr.yuyv[i + 3]) >>> 0;
  if (v !== w) throw new Error(`the screenshot differs from the box's RAM at +0x${i.toString(16)}`);
}
log(`[bridgesim] screenshot: ${sw} x ${sh} from 0x${sa.toString(16)}, the box's framebuffer exactly`);
await get('/service', { method: 'POST', body: 'wtv.example.test' });
if (new TextDecoder().decode((await get('/service')).bytes).trim() !== 'wtv.example.test') throw new Error('the WTVP server did not stick');
await get('/service', { method: 'POST', body: '127.0.0.1' });   // back: the built-in service
// the Box Filesystem's reads and writes, as the page does them (web/wtvdisk.js over /disk)
const boxDisk = new WebTVDisk(async (lba, n) => (await get(`/disk?lba=${lba}&count=${n}`)).bytes, 0, { swapped: false,
  writeRaw: async (lba, b) => { await get(`/disk?lba=${lba}`, { method: 'PUT', body: b }); } });
const fileDisk = new WebTVDisk((lba, n) => disk.getSectors(lba, n), 0);      // the emulated disk itself (the image's byte order)
const bparts = (await boxDisk.partitions()).parts;
const bpart = bparts.find((p) => p.type === 2 && p.name === 'browser');
if (!bpart) throw new Error(`no browser partition through the Bridge: ${bparts.map((p) => p.name)}`);
const bfs = await boxDisk.openFat(bpart);
const payload = new Uint8Array(70000).map((_, i) => (i * 31 + 7) & 0xff);
await bfs.writeFile(null, 'Bridge test file.bin', payload);
const onDisk = await fileDisk.openFat(bpart);
const fent = (await onDisk.list()).find((e) => e.name === 'Bridge test file.bin');
if (!fent || Buffer.compare(Buffer.from(await onDisk.readFile(fent)), Buffer.from(payload))) throw new Error('the file written through the Bridge is not on the disk as written');
const rback = await bfs.readFile((await bfs.list()).find((e) => e.name === 'Bridge test file.bin'));
if (Buffer.compare(Buffer.from(rback), Buffer.from(payload))) throw new Error('the file read back through the Bridge differs');
await bfs.remove(null, { name: 'Bridge test file.bin' });
if ((await onDisk.list()).some((e) => e.name === 'Bridge test file.bin')) throw new Error('the file is still there after Delete');
if (state() !== 'countdown') throw new Error(`the start-up left the WebTV Bridge screen during the web page's work (${state()})`);
log(`[bridgesim] Box Filesystem: ${payload.length} bytes written into ${bpart.name}:/, on the disk as written, read back, deleted`);
summary.push(`5. the web page: a ${sw} x ${sh} screenshot equal to the framebuffer, the WTVP server saved, a file written, read back and deleted in ${bpart.name}:/ through /disk`);
await runFor(1);
png('5-web-busy');
await pageShots([
  ['console', "document.getElementById('out').scrollTop = 0", 1, 'console'],   // the start of what it holds: a boot log
  ['info', null, 6, 'info'],
  ['server', null, 1, 'server'],
  ['os', null, 1, 'ready'],
  ['shot', "document.getElementById('grab').click()", 25, 'screenshot'],
  ['fs', "document.getElementById('load').click()", 8, 'disk'],
  ['fs', "disk.partitions().then(t => openFs(t.parts.find(p => p.name === 'browser')))", 10, 'files'],
]);

// 5. Save this OS, from the web page (the menu is up)
log('--- 5. save this OS (web page)');
const got = Buffer.from(await runWhile(fetch(`${WEB}/os.o`).then((r) => {
  if (!r.ok) return r.text().then((t) => { throw new Error(`Save: ${r.status} ${t}`); });
  return r.arrayBuffer();
}), 'the save', 300));
const want = Buffer.from(osImage.subarray(0, osInfo.size));
if (got.length !== want.length || Buffer.compare(got, want)) throw new Error(`saved ${got.length} bytes, not the image on the disk`);
summary.push(`5. saved ${got.length} bytes from the web page, identical to the image on the disk`);
log(`[bridgesim] saved ${got.length} bytes: identical to the disk's`);
await runUntil(() => state() === 'countdown', 'the menu after the save');
await press('select');                                 // Start now
await runUntil(() => state() === 'os', 'start');
const s4 = osStarts;
await runUntil(() => osStarts > s4, 'the OS');
await online('4');
summary.push(`4. power cycle at ${p4.toFixed(1)} s; countdown stopped, WTVP server set, saved, started; online at ${secs()}`);

// 6. install another OS, from the web page
log('--- 6. install another OS (web page)');
const toInstall = new Uint8Array(readFileSync(installFile));
const p6 = m.cpu.cycles / m.cpuHz;
m.powerCycle();
await runUntil(() => state() === 'countdown' && at('patched') > p6, 'countdown');
const reply6 = await runWhile(fetch(`${WEB}/install`, { method: 'POST', body: toInstall }).then((r) => r.text().then((t) => {
  if (!r.ok) throw new Error(`Install: ${r.status} ${t}`);
  return t;
})), 'the install', 600);
log(`[bridgesim] the web page says: ${reply6.trim()}`);
await runUntil(() => state() === 'countdown', 'the menu after the install');
if (!events.some((e) => e.at > p6 && e.what.startsWith('patched:'))) throw new Error('the installed OS was not patched');
const sel = disk.getSectors(SELECT_LBA, 1)[1];   // the disk keeps bytes swapped in pairs
log(`[bridgesim] select block now ${sel} (booting ${sel ? 'Browser 1' : 'Browser 0'})`);
await press('select');                                 // Start now (the web action held the countdown)
await runUntil(() => state() === 'os', 'start', 15);
const s6 = osStarts;
await runUntil(() => osStarts > s6, 'the new OS');
await online('6');
const p6b = m.cpu.cycles / m.cpuHz;
m.powerCycle();
await runUntil(() => state() === 'countdown' && at('patched') > p6b, 'countdown after the install');
const name6 = events.findLast((e) => e.what.startsWith('patched:')).what.slice(9);
log(`[bridgesim] after a power cycle the box boots ${name6}`);
summary.push(`6. installed ${installFile.replace(/^.*approm\//, '').replace('/_approm.o', '')} from the web page onto the other slot, started it, online; after a power cycle the disk boots ${name6}`);

// 7. the settings that change the OS, set on the TV (6 ended on the countdown)
log('--- 7. remotes and turning on by itself');
// the first key from the web page (the Remote tab), to the WebTV Bridge screen itself
const k7 = await runWhile(fetch(`${WEB}/status`), 'the status', 30);
if (k7.headers.get('X-Keys') !== '1') throw new Error(`X-Keys is ${k7.headers.get('X-Keys')} on the WebTV Bridge screen, not 1`);
const stops7 = events.filter((e) => e.what === 'countdown stopped').length;
const kr7 = await runWhile(fetch(`${WEB}/key?e=0000031e`, { method: 'POST' }), 'POST /key', 30);   // the WebTV remote's Down
if (kr7.status !== 200) throw new Error(`POST /key on the WebTV Bridge screen: ${kr7.status} ${await kr7.text()}`);
await runFor(0.3);
if (events.filter((e) => e.what === 'countdown stopped').length <= stops7) throw new Error('a key from the web page did not stop the countdown');
log('[bridgesim] a key from the web page stopped the countdown');
await press('down', 'select');                         // Settings (the first down stopped the countdown and moved)
await runUntil(() => state() === 'settings', 'settings');
await press('down', 'down', 'select');                 // Remotes
await press('down', 'select');                         // untick Philips
await runFor(0.3);
png('7-remotes');
await press('back');                                   // back to Settings, on Remotes
await press('down');
png('7-power-yes');
await press('select');                                 // Turn on by itself: no
await runFor(0.3);
png('7-settings');
if (!at('remotes: WebTV Sony') || events.findLast((e) => e.what.startsWith('remotes:')).what !== 'remotes: WebTV Sony') throw new Error('Remotes not as set');
if (!events.some((e) => e.what === 'the OS waits for the power key')) throw new Error('Turn on by itself not switched off');
await press('down', 'select');                         // Done (from Turn on by itself)
await runUntil(() => state() === 'countdown', 'back to the countdown');
const d7 = dials, n7 = ipcp, s7 = osStarts;
await press('select');                                 // Start now
await runUntil(() => state() === 'os', 'start', 15);
const entry7 = table.builds[imageIdentity(toInstall).key], o7 = entry7.options, base7 = osImageInfo(toInstall).base & 0x1fffffff;
const ir7 = m.bus.read32(base7 + o7.ir[0]) >>> 0, pw7 = m.bus.read32(base7 + o7.power[0]) >>> 0;
if (ir7 !== ((o7.ir[1] | 1) >>> 0)) throw new Error(`IR word ${ir7.toString(16)}, expected ${((o7.ir[1] | 1) >>> 0).toString(16)} (Sony only)`);
if (pw7 !== o7.power[1] >>> 0) throw new Error(`power word ${pw7.toString(16)}, expected the kPowerOnReboot test ${(o7.power[1] >>> 0).toString(16)}`);
await runUntil(() => osStarts > s7, 'the OS');
// in standby: no dial until the power key
await runFor(15);
if (dials > d7) throw new Error('7: the OS dialled with Turn on by itself off');
await online('7', true);
summary.push(`7. Philips off, Turn on by itself off: InitSoloIR ori ${ir7.toString(16)}, the kPowerOnReboot test kept; the OS waited in standby, then went online after the power key at ${secs()}`);
if (await webReady() !== '0') throw new Error('the web page says Save/Install are on while the OS runs');

// a screenshot while the OS runs: the patched OS reads its framebuffer for the Bridge (PARMOD peeks)
const st8 = await runWhile(fetch(`${WEB}/status`), 'the status', 30);
if (st8.headers.get('X-Mem') !== '2') throw new Error(`X-Mem is ${st8.headers.get('X-Mem')} with the OS online, not 2`);
// a still screen first (the OS may still be fading its splash in): the picture the same for 2 s
{
  const sum = () => { const f = m.solo.video.fb; let h = 0; for (let i = 0; i < f.length; i += 7) h = (h * 31 + f[i]) | 0; return h; };
  let last = sum(), still = 0;
  for (let i = 0; i < 60 && still < 4; i++) { await runFor(0.5); const h = sum(); still = h === last ? still + 1 : 0; last = h; }
}
const t8 = m.cpu.cycles;
const os8 = await grabScreen(readMem, (phys) => 0x80000000 + phys);
const took8 = (m.cpu.cycles - t8) / m.cpuHz;
// against the emulator's own picture of the same screen, in the same window
const V8 = m.solo.video, D8 = V8.draw;
if (os8.mode !== 'compositor' || os8.width !== D8.hsize || os8.height !== D8.vsize) throw new Error(`the OS's screenshot is ${os8.mode}, ${os8.width} x ${os8.height}; the emulator shows ${D8.hsize} x ${D8.vsize}`);
let same8 = 0;
for (let y = 0; y < os8.height; y++) for (let x = 0; x < os8.width; x++) {
  if (os8.rgba[y * os8.width + x] === V8.fb[(D8.vstart + y) * 640 + D8.hstart + x]) same8++;
}
const pct8 = 100 * same8 / (os8.width * os8.height);
// the screen may change while it is read (a blinking cursor): nearly all of it must match
if (pct8 < 98) throw new Error(`the OS's screenshot matches the emulator's picture in only ${pct8.toFixed(1)}% of pixels`);
writePng(join(out, 'bridgesim-8-os-screenshot.png'), os8.rgba, os8.width, os8.height);
log(`[bridgesim] screenshot from the running OS: ${os8.width} x ${os8.height}, composited from ${(os8.bytesRead / 1024).toFixed(0)} KB read over PARMOD in ${took8.toFixed(2)} s; ${pct8.toFixed(2)}% of pixels equal to the emulator's own picture`);
summary.push(`8. a screenshot from the running OS over PARMOD: ${os8.width} x ${os8.height}, composited from ${(os8.bytesRead / 1024).toFixed(0)} KB in ${took8.toFixed(1)} s (emulated), ${pct8.toFixed(1)}% of pixels equal to the emulator's own`);
// 9. keys from the web page into the running OS (7181): its IR input ring, as its decoders fill it
const sym9 = symbolSource(readFileSync(installFile.replace(/_approm\.o$/, 'symbols.sym')), new Uint8Array(readFileSync(installFile)));
const pa = (n) => sym9.addr(n) & 0x1fffffff, IRBUF = pa('irDataBuf'), IRHEAD = pa('irHead'), IRTAIL = pa('irTail');
const st9 = await runWhile(fetch(`${WEB}/status`), 'the status', 30);
if (st9.headers.get('X-Keys') !== '2') throw new Error(`X-Keys is ${st9.headers.get('X-Keys')} with the OS online, not 2`);
const keys9 = [0x0000031e, 0x941e0000, 0xd41e0000];   // the remote's Down; the IR keyboard's A, pressed and let go
const h9 = m.bus.read32(IRHEAD) & 63;
const kr9 = await runWhile(fetch(`${WEB}/key?e=${keys9.map((k) => k.toString(16).padStart(8, '0')).join(',')}`, { method: 'POST' }), 'POST /key', 30);
if (kr9.status !== 200) throw new Error(`POST /key with the OS running: ${kr9.status} ${await kr9.text()}`);
await runUntil(() => ((m.bus.read32(IRHEAD) - h9) & 63) >= keys9.length, 'the keys in the OS\'s IR ring', 10);
await runFor(0.5);
let t9 = 0;
keys9.forEach((k, i) => {
  const slot = (h9 + 1 + i) & 63, w0 = m.bus.read32(IRBUF + slot * 8) >>> 0, w1 = m.bus.read32(IRBUF + slot * 8 + 4) >>> 0;
  if (w0 !== k) throw new Error(`IR ring slot ${slot}: ${w0.toString(16)}, not ${k.toString(16)}`);
  if (!w1 || w1 < t9) throw new Error(`IR ring slot ${slot}: time ${w1}`);
  t9 = w1;
});
if ((m.bus.read32(IRTAIL) & 63) !== (m.bus.read32(IRHEAD) & 63)) throw new Error('the OS has not taken the keys from its IR ring');
log(`[bridgesim] keys from the web page: ${keys9.length} in the OS's IR ring, with its clock (${t9}), and taken`);
summary.push(`9. keys from the web page: to the WebTV Bridge screen (the countdown stopped); to the running OS over PARMOD, ${keys9.length} entries in its IR ring as its decoders write them, taken by IRIdle`);

await pageShots([['os', null, 1, 'not-ready'], ['fs', null, 1, 'fs-not-ready'],
  ['shot', "document.getElementById('grab').click()", 60, 'os-screenshot'], ['remote', null, 3, 'remote']]);   // the OS online: greyed out, and a screenshot of it

log('--- summary (emulated time)');
for (const s of summary.sort()) log(s);
pico.close();
process.exit(0);
