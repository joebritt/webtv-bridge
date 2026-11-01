// Headless runner for debugging.
//   node tools/run.mjs [--cycles N] [--disk path] [--rom path] [--trace-tail N] [--break hexpc [--break-after N]] [--mmio] [--press cycles:button] [--key cycles:Code]
//                      [--net ws://localhost:8081] [--host-map name=ip] [--ppp-auth pap|chap] [--modem-trace]
//                      [--install-os FILE [--lpt [--syms FILE]]] [--pico ...]
//                      [--net builtin [--wtv-account NAME] [--wtv-visit URL] [--wtv-listen]]
//                      [--lpt-console | --lpt-diag [--con-answer 'prompt=reply'] [--lpt-console-listen PORT]] [--lpt-dongle] [--debugger]
//                      [--type 'cycles:text' [--type-gap N]] [--remote 'cycles:button'] [--png-at 'cycles:file.png'] [--png file.png] [--ram-at 'cycles:file.bin']
import { readFileSync, openSync, readSync, fstatSync } from 'node:fs';
import { WebTV } from '../src/machine/webtv.js';
import { OverlayDisk } from '../src/machine/ide.js';
import { disasm, REG_NAMES } from '../src/cpu/disasm.js';
import { writePng } from './png.mjs';
import { createNetworkLine } from '../src/net/line.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);
// --lpt: patch the installed build for the LPT bridge. The emulator's bridge serves its PARMOD
// session; the console channel is logged as [pmcon] lines (and served with --lpt-console-listen
// PORT, answered with --con-answer)
const lptPatch = flag('lpt');

const romPath = opt('rom', 'data/flipped_merged_boot.bin');
const diskPath = opt('disk', 'data/debug_webtv_w200_7.bin');
const cycles = Number(opt('cycles', '50000000'));
const tail = Number(opt('trace-tail', '0'));
const breakPc = opt('break') ? parseInt(opt('break'), 16) | 0 : null;
const breakAfter = Number(opt('break-after', 0)); // --break-after N: ignore --break before cycle N
const sample = Number(opt('sample', '0'));

let disk = null;
if (diskPath !== 'none') {
  const fd = openSync(diskPath, 'r');
  const size = fstatSync(fd).size;
  disk = new OverlayDisk(size, (lba, count) => {
    const b = new Uint8Array(count * 512);
    readSync(fd, b, 0, b.length, lba * 512);
    return b;
  });
}

const t0 = Date.now();
const lines = [];
const log = (...a) => { const s = a.join(' '); console.log(s); };
// --install-os FILE: put an OS build image (e.g. a collection _approm.o) in the disk's firmware slot
if (opt('install-os') && disk) {
  const { osInstallSectors } = await import('../src/machine/osinstall.js');
  let img = new Uint8Array(readFileSync(opt('install-os')));
  // --lpt: patch the build for the LPT modem bridge first (needs symbols.sym next to it, or --syms FILE)
  if (lptPatch) {
    const { patchLptBuild } = await import('../src/lptmodem/patchbuild.js');
    const { dirname, join } = await import('node:path');
    const { existsSync } = await import('node:fs');
    const symFile = opt('syms', join(dirname(opt('install-os')), 'symbols.sym'));
    // no symbols: the names come from the code, by signature
    const r = patchLptBuild(img, existsSync(symFile) ? readFileSync(symFile) : null, { noDriverCaves: flag('lpt-no-driver-caves') });
    for (const l of r.report) log(`[lpt] ${l}`);
    img = r.image;
  }
  const { info, sectors } = osInstallSectors(img);
  for (const [lba, d] of sectors) disk.dirty.set(lba, d);
  log(`[os] installed ${opt('install-os')}: ${sectors.size} sectors, base ${info.base.toString(16)}, checksum ${info.checksumOk ? 'ok' : 'BAD'}`);
}
const m = new WebTV({ rom: readFileSync(romPath), disk, log });

let dbgLine = '';
// --answer 'prompt text=reply' (repeatable): type `reply` on the debug console when prompt appears
const answers = [];
args.forEach((a, i) => { if (a === '--answer') { const [k, v] = args[i + 1].split('='); answers.push({ k, v, done: false }); } });
// --dump-on TEXT: when the debug console prints TEXT, dump the interrupt state
const dumpOn = opt('dump-on');
function dumpInts() {
  const S = m.solo, V = S.video;
  const h = (x) => (x >>> 0).toString(16);
  console.log(`[dump] busStat=${h(S.busStat())} busEn=${h(S.busEn)} vid{stat=${h(S.vidInt.stat)} en=${h(S.vidInt.en)}}`
    + ` pot{stat=${h(V.pot.intstat)} en=${h(V.pot.inten)} cntl=${h(V.pot.cntl)} hint=${h(V.pot.hintline)}}`
    + ` gfx{stat=${h(V.gfx.intstat)} en=${h(V.gfx.inten)}} vid{stat=${h(V.vid.intstat)} en=${h(V.vid.inten)}} div{stat=${h(V.div.intstat)} en=${h(V.div.inten)}}`
    + ` dev{stat=${h(S.devInt.stat)} en=${h(S.devInt.en)}} aud{stat=${h(S.audInt.stat)} en=${h(S.audInt.en)}} rio{stat=${h(S.rioInt.stat)} en=${h(S.rioInt.en)}} tim{stat=${h(S.timInt.stat)} en=${h(S.timInt.en)}}`);
}
m.solo.debugOut = (c) => {
  if (c === 10) { console.log('[dbg] ' + dbgLine); if (dumpOn && dbgLine.includes(dumpOn)) dumpInts(); dbgLine = ''; }
  else if (c !== 13) dbgLine += String.fromCharCode(c);
  for (const a of answers) {
    if (!a.done && dbgLine.includes(a.k)) {
      a.done = true;
      for (const ch of a.v) m.solo.debugInput(ch.charCodeAt(0));
    }
  }
};
m.onLeds = (v) => log(`[led] ${(v & 7).toString(2).padStart(3, '0')}`);

// --net RELAY_URL: give the modem a line (PPP server + TCP relay); '--net offline' = PPP without a relay;
// '--net builtin' = the in-page WebTV service (src/wtvsrv), optionally with --relay URL for other hosts
const netUrl = opt('net');
if (netUrl) {
  const hostMap = {};
  args.forEach((a, i) => { if (a === '--host-map') { const [k, v] = args[i + 1].split('='); hostMap[k] = v; } });
  let service = null, relayUrl = netUrl === 'offline' ? null : netUrl;
  if (netUrl === 'builtin') {
    const { WebTVService } = await import('../src/wtvsrv/service.js');
    // --wtv-account NAME: boxes start out registered as NAME; --wtv-visit URL: home sends the box there
    const acct = opt('wtv-account');
    service = new WebTVService({ log, visit: opt('wtv-visit', null),
      account: acct ? { registered: true, subscriber_name: acct, subscriber_username: acct } : null });
    relayUrl = opt('relay', null);
    // --wtv-listen: also serve it on 127.0.0.1's WTVP ports, for the bridge firmware's own TCP
    // (--pico --pico-service 127.0.0.1)
    if (flag('wtv-listen')) {
      const net = await import('node:net');
      const { SERVICE_PORTS } = await import('../src/wtvsrv/service.js');
      for (const port of SERVICE_PORTS) {
        const srv = net.createServer((sock) => {
          sock.setNoDelay(true);
          const conn = service.openConnection(port, { send: (d) => sock.write(d), close: () => sock.end() });
          sock.on('data', (d) => conn.receive(new Uint8Array(d)));
          sock.on('close', () => { conn.closed = true; });
          sock.on('error', () => {});
        });
        srv.listen(port, '127.0.0.1');
        srv.unref();
      }
      log(`[wtv] service listening on 127.0.0.1 ports ${SERVICE_PORTS.join(' ')}`);
    }
  }
  m.modemLine.line = createNetworkLine({ relayUrl, service, hostMap, auth: opt('ppp-auth', null), log });
  m.lptBridge.modem.line = createNetworkLine({ relayUrl, service, hostMap, auth: opt('ppp-auth', null), log });
}
// --pico: the bridge on the parallel port is the Pico firmware itself, both cores, built to
// WebAssembly (pico/sim, `make` there first; src/machine/picosim.js): the dongle, diagnostics,
// loader, the OS patched in RAM, PARMOD and the modem stack all run as on the Pico, against the
// emulated pins. --pico-settings FILE keeps its flash settings sector (default: none, a fresh
// bridge); --pico-service HOST sets the WTVP server; --pico-log N its log level; --pico-console
// 'cycles:text' types a line at its USB console. Its web page is on http://127.0.0.1:8080/.
// --pico-scan-crowd N: the simulated radio's scans hear N more reports, as in a crowded building
// (weak neighbours, each heard several times), to exercise the TV's network list
// --pico-trace FILE writes the cable as a logic analyzer would see it (Logic 2's CSV export, for
// tools/saleae/lptscope.py analyze), at most --pico-trace-limit rows (default 2000000).
let pico = null;
if (flag('pico')) {
  const { PicoSim } = await import('../src/machine/picosim.js');
  pico = await PicoSim.create(m, { settingsFile: opt('pico-settings', null), service: opt('pico-service', ''),
    logLevel: Number(opt('pico-log', '-1')), log, trace: opt('pico-trace', null), traceLimit: Number(opt('pico-trace-limit', '2000000')),
    scanCrowd: Number(opt('pico-scan-crowd', '0')) });
  args.forEach((a, i) => {
    if (a !== '--pico-console') return;
    const v = args[i + 1], k = v.indexOf(':');
    const at = Number(v.slice(0, k)), text = v.slice(k + 1).replace(/\\r/g, '\r') + '\r';
    m.sched.at(`pico-console-${i}`, at, () => { log(`[input] pico console: ${v.slice(k + 1)}`); pico.console(text); });
  });
}
// --lpt-console: the LPT bridge is the far end of a debug build's parallel-port debug console
// instead of the modem bridge (an unpatched build with "Parallel Port" in Debug Terminal Setup).
// Its output is logged as [lptcon] lines. --con-answer 'prompt=reply' (repeatable, \n and \r
// escapes) types reply when prompt appears; --lpt-console-listen PORT also serves the console on
// 127.0.0.1:PORT (nc 127.0.0.1 PORT), as the bridge does over WiFi.
// --lpt-diag: the same, but for the boot ROM's factory diagnostics console on a stock box: the
// bridge plays the loopback dongle so the ROM enters diagnostics, then speaks its 19200-baud
// serial line (src/machine/lptdiag.js).
let lptCon = null, lptConServer = null;
const clients = new Set();
if (flag('lpt-console') || flag('lpt-diag') || opt('lpt-console-listen') || (lptPatch && args.includes('--con-answer'))) {
  const { LptConsoleHost } = await import('../src/machine/lptconsole.js');
  const { LptDiagHost } = await import('../src/machine/lptdiag.js');
  const conAnswers = [];
  args.forEach((a, i) => { if (a === '--con-answer') { const k = args[i + 1].indexOf('='); conAnswers.push({ k: args[i + 1].slice(0, k), v: args[i + 1].slice(k + 1).replace(/\\n/g, '\n').replace(/\\r/g, '\r'), done: false }); } });
  let line = '', seen = ''; // seen: what arrived since the last newline or answer, for matching prompts
  // a patched build: the console is a channel of the bridge's PARMOD session
  function ParmodConsole({ out }) {
    const pm = m.lptBridge.useParmod({ onConsole: out });
    pm.type = (text) => { for (const ch of text) pm.consoleIn.push(ch.charCodeAt(0) & 0xff); pm.kick(); };
    return pm;
  }
  const pmcon = !flag('lpt-console') && !flag('lpt-diag');
  const Host = pmcon ? ParmodConsole : flag('lpt-diag') ? LptDiagHost.bind(null, m) : LptConsoleHost;
  const tag = pmcon ? '[pmcon]' : '[lptcon]';
  lptCon = new Host({
    out: (c) => {
      for (const s of clients) s.write(Buffer.from([c]));
      if (c === 10) { log(`${tag} ` + line); line = seen = ''; } else if (c !== 13) { line += String.fromCharCode(c); seen += String.fromCharCode(c); }
      const a = conAnswers.find((x) => !x.done);
      if (a && seen.includes(a.k)) { a.done = true; seen = ''; lptCon.type(a.v); }
    },
  });
  if (!pmcon) m.lptBridge.setConsole(lptCon);
  if (opt('lpt-console-listen')) {
    const net = await import('node:net');
    lptConServer = net.createServer((s) => {
      clients.add(s);
      s.on('data', (d) => lptCon.type(d.toString('latin1').replace(/\0/g, '')));
      s.on('close', () => clients.delete(s));
      s.on('error', () => clients.delete(s));
    }).listen(Number(opt('lpt-console-listen')), '127.0.0.1');
    log(`[lptcon] console on 127.0.0.1:${opt('lpt-console-listen')}`);
  }
}
// --debugger: Debugger() breaks (break 0x1c800) enter the ROM's debug monitor instead of being
// logged and skipped
if (flag('debugger')) m.skipDebugger = false;
// --lpt-dongle: a loopback plug on the parallel port instead of the bridge (src/machine/lptdongle.js)
if (flag('lpt-dongle')) {
  const { LptDongle } = await import('../src/machine/lptdongle.js');
  m.lptBridge.setConsole(new LptDongle());
  log('[lpt] loopback dongle on the parallel port');
}
let modemTraceFlush = () => {};
if (flag('modem-trace')) {
  let dir = '', buf = [];
  const flush = () => { if (buf.length) log(`[modem ${dir}] ${buf.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`); buf = []; };
  m.modemLine.trace = m.lptBridge.modem.trace = (d, b) => { if (d !== dir || buf.length >= 32) { flush(); dir = d; } buf.push(b); };
  modemTraceFlush = flush;
}

// --poll ADDR[,ADDR...]: log whenever these RAM words (physical) or the parallel port CTRL/IEN change
if (opt('poll')) {
  const addrs = opt('poll').split(',').map((a) => parseInt(a, 16) >>> 0);
  const last = new Map();
  const tick = () => {
    const vals = [...addrs.map((a) => ['ram ' + a.toString(16), m.bus.read32(a) >>> 0]), ['pp.ctrl', m.solo.pport.ctrl], ['pp.ien', m.solo.pport.ien]];
    for (const [k, v] of vals) if (last.get(k) !== v) { last.set(k, v); log(`[poll] @${m.cpu.cycles} ${k} = ${v.toString(16)}`); }
    m.sched.after('poll', 100000, tick);
  };
  m.sched.after('poll', 1, tick);
}
if (flag('mmio')) {
  m.bus.watch = (pa, size, w, v) => {
    if (pa >= 0x04000000 && pa < 0x04010000)
      log(`[mmio] ${w ? 'W' : 'R'}${size * 8} ${(pa >>> 0).toString(16)} ${w ? '<-' : '->'} ${(v >>> 0).toString(16)} pc=${(m.cpu.curPC >>> 0).toString(16)}`);
  };
}

const ring = tail ? new Array(tail) : null;
let ringPos = 0;
if (ring || breakPc !== null) {
  m.cpu.traceHook = (pc, op) => {
    if (ring) { ring[ringPos] = [pc, op]; ringPos = (ringPos + 1) % tail; }
    if (pc === breakPc && m.cpu.cycles >= breakAfter) { m.stopped = true; m.cpu.stopRequested = true; }
  };
}

function dumpRegs() {
  const c = m.cpu;
  const r = [];
  for (let i = 0; i < 32; i++) r.push(`${REG_NAMES[i].padStart(4)}=${(c.gprL[i] >>> 0).toString(16).padStart(8, '0')}`);
  for (let i = 0; i < 32; i += 4) console.log(r.slice(i, i + 4).join(' '));
  console.log(`pc=${(c.pc >>> 0).toString(16)} sr=${(c.cp0[12] >>> 0).toString(16)} cause=${(c.cp0[13] >>> 0).toString(16)} epc=${(c.cp0[14] >>> 0).toString(16)} count=${(c.getCount() >>> 0).toString(16)}`);
}

// --press 'cycles:button' (repeatable): press a remote button at the given CPU cycle count (sent
// as the IR keyboard's equivalent key)
// --remote 'cycles:button' (repeatable): press a button on the WebTV remote itself (its own IR
// frames, decoded by the OS's EchoStar-style decoder; names in src/machine/ir.js REMOTE)
// --key 'cycles:Code' (repeatable): tap a keyboard key (KeyboardEvent.code) at the given cycle
// --type 'cycles:text' (repeatable): type text on the keyboard from the given cycle, one character
// every --type-gap cycles (default 30M; the OS drops keys that come much faster)
const presses = [];
const typeGap = Number(opt('type-gap', '30000000'));
args.forEach((a, i) => {
  if (a === '--press' || a === '--key' || a === '--remote') {
    const v = args[i + 1], k = v.indexOf(':');
    presses.push({ at: Number(v.slice(0, k)), name: v.slice(k + 1), kind: a.slice(2) });
  } else if (a === '--type') {
    const v = args[i + 1], k = v.indexOf(':');
    [...v.slice(k + 1)].forEach((ch, j) => presses.push({ at: Number(v.slice(0, k)) + j * typeGap, name: ch, kind: 'type' }));
  }
});
presses.sort((a, b) => a.at - b.at);
// a box reset clears the scheduler: the presses still to come are scheduled again after one
const schedulePresses = () => presses.forEach((p, i) => {
  if (p.done || p.at < m.cpu.cycles) return;
  m.sched.at(`press-${p.at}-${i}`, p.at, () => {
    p.done = true;
    const what = { press: 'button', key: 'key', type: 'text', remote: 'remote button' }[p.kind];
    log(`[input] ${what} ${p.kind === 'type' ? JSON.stringify(p.name) : p.name} at ${m.cpu.cycles}`);
    const ok = p.kind === 'type' ? m.ir.typeText(p.name) : p.kind === 'key' ? (m.ir.keyDown(p.name) && m.ir.keyUp(p.name))
      : p.kind === 'remote' ? m.ir.pressRemote(p.name) : m.ir.pressButton(p.name);
    if (!ok) log(`[input] can't send ${what} ${p.name}`);
  });
});
schedulePresses();
{ const prev = m.onReset; m.onReset = () => { if (prev) prev(); schedulePresses(); }; }

// --box-reset cycles (repeatable): reset the box there, as a crash or the reset button would (a
// software reset: RAM kept)
args.forEach((a, i) => {
  if (a !== '--box-reset') return;
  const at = Number(args[i + 1]);
  const arm = () => { if (m.cpu.cycles < at) m.sched.at(`box-reset-${i}`, at, () => { log(`[input] box reset at ${m.cpu.cycles}`); m.requestReset('test'); }); };
  arm();
  const prev = m.onReset; m.onReset = () => { if (prev) prev(); arm(); };
});

// --png-at 'cycles:file.png' (repeatable): screenshot at the given cycle
// --ram-at 'cycles:file.bin' (repeatable): write all of RAM, big-endian, at the given cycle
// (like the presses, scheduled again after a box reset)
const snaps = [];
args.forEach((a, i) => {
  if (a !== '--png-at' && a !== '--ram-at') return;
  const v = args[i + 1], k = v.indexOf(':');
  snaps.push({ at: Number(v.slice(0, k)), file: v.slice(k + 1), ram: a === '--ram-at' });
});
const scheduleSnaps = () => snaps.forEach((s, i) => {
  if (s.done || s.at < m.cpu.cycles) return;
  m.sched.at(`snap-${i}`, s.at, async () => {
    s.done = true;
    if (!s.ram) { writePng(s.file, m.solo.video.fb, 640, 480); log(`[png] ${s.file} at ${m.cpu.cycles}`); return; }
    const ram = m.bus.ram, out = Buffer.alloc(ram.length * 4);
    for (let j = 0; j < ram.length; j++) out.writeInt32BE(ram[j], j * 4);
    (await import('node:fs')).writeFileSync(s.file, out);
    log(`[ram] ${s.file} at ${m.cpu.cycles}`);
  });
});
scheduleSnaps();
{ const prev = m.onReset; m.onReset = () => { if (prev) prev(); scheduleSnaps(); }; }

// --hot-threshold N: JIT compiles a block after it has been entered N times
if (opt('hot-threshold')) (await import('../src/cpu/jit.js')).setHotThreshold(Number(opt('hot-threshold')));
// --no-superblocks: end every compiled block at its first branch
if (flag('no-superblocks')) (await import('../src/cpu/jit.js')).setSuperblocks(false);

// --profile FROM:TO:FILE  write a V8 CPU profile (.cpuprofile) of the cycles FROM..TO
//                         (FILE '-' only times the window)
let prof = null;
if (opt('profile')) {
  const [from, to, file] = opt('profile').split(':');
  const { Session } = await import('node:inspector/promises');
  prof = { from: Number(from), to: Number(to), file, session: new Session(), on: false, wall: 0 };
  prof.session.connect();
  await prof.session.post('Profiler.enable');
}

const step = sample || 10000000;
let done = 0;
const pcHist = new Map();
while (done < cycles && !m.stopped) {
  const n = Math.min(netUrl ? Math.min(step, 2000000) : step, cycles - done);
  if (prof && !prof.on && m.cpu.cycles >= prof.from && m.cpu.cycles < prof.to) {
    prof.on = true; prof.c0 = m.cpu.cycles; prof.wall = Date.now();
    prof.j0 = { compiled: m.cpu.jit.compiled, inval: m.cpu.jit.invalidations, interp: m.cpu.interpSteps };
    if (prof.file !== '-') await prof.session.post('Profiler.start');
  }
  m.run(n);
  done += n;
  if (prof && prof.on && m.cpu.cycles >= prof.to) {
    if (prof.file !== '-') { // '-': just time the window
      const { profile } = await prof.session.post('Profiler.stop');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(prof.file, JSON.stringify(profile));
    }
    const secs = (Date.now() - prof.wall) / 1000;
    log(`[profile] jit: ${m.cpu.jit.compiled - prof.j0.compiled} blocks compiled, ${m.cpu.jit.invalidations - prof.j0.inval} page invalidations, ${m.cpu.interpSteps - prof.j0.interp} interpreter steps; ${m.cpu.jit.blocks.size} blocks cached`);
    log(`[profile] ${m.cpu.cycles - prof.c0} cycles in ${secs.toFixed(2)}s (${((m.cpu.cycles - prof.c0) / secs / 1e6).toFixed(0)} MIPS) -> ${prof.file}`);
    prof.on = false; prof.to = Infinity;
  }
  if (netUrl || lptConServer || pico) await new Promise((r) => setImmediate(r)); // let relay / console sockets and timers run
  if (sample) {
    const pc = (m.cpu.pc >>> 0).toString(16);
    log(`[sample] cycles=${m.cpu.cycles} pc=${pc} ${disasm(m.cpu.fetch(m.cpu.pc), m.cpu.pc)}`);
  }
}
if (dbgLine) console.log('[dbg] ' + dbgLine);
if (flag('modem-trace')) {
  modemTraceFlush();
  const u = m.modem, ml = m.modemLine;
  log(`[modem] state: online=${ml.online} queued=${ml.out.length} uart rx=${u.rx.length} ier=${u.ier} mcr=${u.mcr} msr=${u.msr.toString(16)} lcr=${u.lcr.toString(16)}`);
  // --peek ADDR[,ADDR...]: print RAM words at the end of the run
  if (opt('peek')) for (const a of opt('peek').split(',')) log(`[peek] ${a} = ${(m.bus.read32(parseInt(a, 16) >>> 0) >>> 0).toString(16)}`);
  const lb = m.lptBridge, pp = m.solo.pport;
  log(`[lpt] state: online=${lb.modem.online} dtr=${lb.dtr} dcd=${lb.dcd} stats=${JSON.stringify(lb.stats)} ctrl=${pp.ctrl.toString(16)} ien=${pp.ien} ist=${pp.ist} en=${pp.enable}`);
}
if (m.lptBridge.pm && (flag('modem-trace') || flag('lpt-stats'))) {
  const pm = m.lptBridge.pm;
  log(`[parmod] session=${pm.session} modemIn=${pm.modemIn.length} consoleIn=${pm.consoleIn.length} carrier=${pm.carrier} full=${pm.full} stats=${JSON.stringify(pm.stats)}`);
}
const dt = (Date.now() - t0) / 1000;
if (pico) pico.close();
if (lptConServer) { lptConServer.close(); for (const s of clients) s.end(); }
console.log(`--- ran ${m.cpu.cycles} instructions in ${dt.toFixed(2)}s (${(m.cpu.cycles / dt / 1e6).toFixed(1)} MIPS)`);
dumpRegs();
if (ring) {
  console.log('--- trace tail');
  for (let i = 0; i < tail; i++) {
    const e = ring[(ringPos + i) % tail];
    if (e) console.log((e[0] >>> 0).toString(16).padStart(8, '0'), disasm(e[1], e[0]));
  }
}
if (opt('png')) { writePng(opt('png'), m.solo.video.fb, 640, 480); console.log('wrote ' + opt('png')); }
if (opt('dis')) {
  const [a, n] = opt('dis').split(':');
  let pc = parseInt(a, 16) | 0;
  for (let i = 0; i < Number(n || 32); i++, pc += 4) {
    const op = m.cpu.fetch(pc);
    console.log((pc >>> 0).toString(16), (op >>> 0).toString(16).padStart(8, '0'), disasm(op, pc));
  }
}
if (flag('vregs')) {
  const v = m.solo.video;
  console.log('vid', JSON.stringify(v.vid, (k, x) => typeof x === 'number' ? '0x' + (x >>> 0).toString(16) : x));
  console.log('pot', JSON.stringify(v.pot, (k, x) => typeof x === 'number' ? '0x' + (x >>> 0).toString(16) : x));
  console.log('draw', JSON.stringify(v.draw));
}
if (flag('cels')) {
  const v = m.solo.video, G = v.gfx, ram = m.bus.ram;
  const rd = (a) => ram[(a & m.bus.ramMask) >>> 2] >>> 0;
  console.log('gfx', JSON.stringify(G, (k, x) => typeof x === 'number' ? '0x' + (x >>> 0).toString(16) : x));
  for (let i = 0; i < 12; i++) {
    const ym = rd(G.ymapBaseMaster + i * 4);
    console.log(`ymap[${i}] ${ym.toString(16)} cnt=${(ym >>> 23) & 0x1ff} top=${((ym >>> 13) & 0x3ff)} dis=${(ym >>> 12) & 1} size=${(ym >>> 10) & 3} blk=${ym & 0x3ff}`);
    if (((ym >>> 13) & 0x3ff) === 0x1ff) break;
    const sz = [8, 16, 48, 48][(ym >>> 10) & 3];
    let p = G.celsBaseMaster + ((ym & 0x3ff) << 3);
    for (let c = 0; c < 6; c++) {
      const w = []; for (let k = 0; k < sz / 4; k++) w.push(rd(p + 4 * k).toString(16).padStart(8, '0'));
      console.log('   cel', w.join(' '));
      if ((rd(p) >>> 31) & 1) break;
      p += sz;
    }
  }
}
