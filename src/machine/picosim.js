// The bridge on the box's parallel port, played by its own firmware: pico/sim builds the Pico
// firmware's C (both cores, unchanged) to WebAssembly, and this puts it on the emulated SOLO
// port as the peripheral, in place of the emulator's JS bridge.
//
//   const pico = await PicoSim.create(machine, { settingsFile, service, log });
//
// Pins: every change the box makes to its lines goes straight to core 1 (port_step), and every
// change the firmware makes comes straight back (port.update()), so an nAck pulse is an edge the
// box sees. Time is the box's cycle counter, which box resets don't clear: the Pico runs on,
// as a real one powered from USB does. Core 0 runs every 250 us of emulated time; core 1 also
// ticks every 4 us while the diagnostics serial needs timing (the dongle mode).
//
// The firmware's TCP (the gateway's connections, its web page on 127.0.0.1:8080 and the box's
// console on 2323) goes through this process's sockets; WiFi itself is simulated inside
// (pico/sim/net_sim.c).
//
// trace: a file for the cable as a logic analyzer at J2 would see it, in Logic 2's CSV export
// format (tools/saleae/lptscope.py analyze reads it): a row per change, emulated seconds, the
// data lines as whoever drives them (the box, the bridge, or the pull-ups' 0xFF). traceLimit
// rows at most.

import { readFileSync, writeFileSync, existsSync, openSync, writeSync, closeSync } from 'node:fs';
import net from 'node:net';
import dns from 'node:dns';

const CORE0_US = 250;
const TICK_US = 4;
const DONGLE = 1;
const STATES = ['off', 'armed', 'wifi', 'loading', 'patching', 'countdown', 'settings', 'saving', 'installing', 'os', 'no-tier3'];

export class PicoSim {
  static async create(machine, opts = {}) {
    const p = new PicoSim(machine, opts);
    await p.load();
    return p;
  }

  constructor(machine, { settingsFile = null, service = '', logLevel = -1, log = machine.log, trace = null, traceLimit = 2e6, scanCrowd = 0 } = {}) {
    Object.assign(this, { m: machine, settingsFile, service, logLevel, log, scanCrowd });
    if (trace) {
      this.trace = { fd: openSync(trace, 'w'), left: traceLimit, last: -1, buf: [] };
      this.trace.buf.push('Time [s],nStrobe,nAutoFd,nInit,nSelectIn,nAck,Busy,PError,Select,nFault,D0,D1,D2,D3,D4,D5,D6,D7\n');
    }
    this.port = null;
    this.status = 0x1f;           // STAT as the box reads it
    this.data = null;
    this.conns = new Map(); this.nextId = 1;
    this.servers = new Map();
    this.resolves = new Map();
    this.line = '';
    this.lastUs = 0; this.usBase = 0;
  }

  async load() {
    const { default: createFirmware } = await import('../../pico/sim/out/lptbridge.mjs');
    const host = this.host();
    this.fw = await createFirmware({
      simHost: host,
      print: (s) => this.log(s),
      printErr: (s) => this.log(`[pico stderr] ${s}`),
    });
    this.fw.ccall('sim_init', null, ['number', 'string'], [this.logLevel, this.service]);
    if (this.scanCrowd) this.fw._sim_scan_crowd(this.scanCrowd);   // a crowded building's WiFi scan
    // the Pico is on the port from now on, and the boot ROM's Debugger() runs as on a real box
    // (the emulator skips it by default; test 18 needs it)
    this.m.skipDebugger = false;
    this.m.solo.pport.attach(this);
    this.arm();
    const prev = this.m.onReset;
    this.m.onReset = () => { if (prev) prev(); this.arm(); };   // a box reset clears the scheduler
  }

  // ---- the platform the firmware runs on
  nowUs() {
    // the box's cycles at 167 MHz; never backwards
    const us = Math.floor(this.m.cpu.cycles * 1e6 / this.m.cpuHz);
    if (us < this.lastUs) this.usBase += this.lastUs - us;
    this.lastUs = us;
    return (us + this.usBase) >>> 0;
  }

  host() {
    return {
      nowUs: () => this.nowUs(),
      pinsChanged: () => this.pinsChanged(),
      settingsRead: (len) => (this.settingsFile && existsSync(this.settingsFile) ? new Uint8Array(readFileSync(this.settingsFile)) : null),
      settingsWrite: (bytes) => { if (this.settingsFile) writeFileSync(this.settingsFile, bytes); return true; },
      reboot: () => this.log('[pico] reboot asked for (ignored in the simulation)'),
      tcpOpen: (h, p) => this.tcpOpen(h, p),
      tcpState: (id) => { const c = this.conns.get(id); return !c || c.error ? -1 : c.open ? 1 : 0; },
      tcpRecv: (id, max) => this.tcpRecv(id, max),
      tcpSend: (id, bytes) => this.tcpSend(id, bytes),
      tcpEnd: (id) => { const c = this.conns.get(id); if (c && c.sock) c.sock.end(); },
      tcpClose: (id) => { const c = this.conns.get(id); if (c) { if (c.sock) c.sock.destroy(); this.conns.delete(id); } },
      tcpError: (id) => this.conns.get(id)?.error || 'connection failed',
      resolve: (name) => this.resolve(name),
      resolveResult: (id) => { const r = this.resolves.get(id); if (!r || r.pending) return null; this.resolves.delete(id); return r.ip; },
      listen: (port) => this.listen(port),
      accept: (lid) => { const q = this.servers.get(lid); return q && q.length ? q.shift() : -1; },
    };
  }

  // ---- the parallel port: a SOLO peripheral (solo_pport.js)
  attach(port) { this.port = port; this.hostChanged(); }

  hostChanged() {
    if (!this.fw || !this.port) return;
    const p = this.port;
    this.fw._sim_box(p.ctrl & 0x0f, p.driving ? p.data : 0xff, p.driving ? 1 : 0);
    this.pinsChanged();
    this.record();
    this.armTick();
  }

  pinsChanged() {
    if (!this.fw) return;
    this.status = this.fw._sim_status();
    const d = this.fw._sim_data();
    this.data = d < 0 ? null : d;
    if (this.port) this.port.update();
    this.record();
  }

  // the cable, for the trace: control lines (CTRL bits = levels), status lines (STAT bits = levels)
  record() {
    const tr = this.trace;
    if (!tr || !this.port || tr.left <= 0) return;
    const p = this.port, c = p.ctrl, s = this.status;
    const data = p.driving ? p.data : this.data != null ? this.data : 0xff;
    const key = (c & 0x0f) | (s & 0x1f) << 4 | data << 9;
    if (key === tr.last) return;
    tr.last = key;
    const bits = [c & 1, c >> 2 & 1, c >> 1 & 1, c >> 3 & 1, s >> 1 & 1, s & 1, s >> 4 & 1, s >> 3 & 1, s >> 2 & 1];   // the header's order
    for (let i = 0; i < 8; i++) bits.push(data >> i & 1);
    tr.buf.push(`${(this.m.cpu.cycles / this.m.cpuHz).toFixed(9)},${bits.join(',')}\n`);
    if (--tr.left === 0) this.log('[pico] trace: row limit reached');
    if (tr.buf.length >= 4096) this.flushTrace();
  }

  flushTrace() {
    const tr = this.trace;
    if (!tr || !tr.buf.length) return;
    writeSync(tr.fd, tr.buf.join(''));
    tr.buf = [];
  }

  // ---- time
  cyclesFor(us) { return Math.max(1, Math.round(us * this.m.cpuHz / 1e6)); }

  arm() {
    this.m.sched.after('pico-core0', this.cyclesFor(CORE0_US), () => this.core0());
    this.armTick();
  }

  core0() {
    this.fw._sim_core0();
    this.m.sched.after('pico-core0', this.cyclesFor(CORE0_US), () => this.core0());
    this.armTick();
  }

  armTick() {
    if (this.fw._sim_mode() !== DONGLE || this.m.sched.pending('pico-tick')) return;
    this.m.sched.after('pico-tick', this.cyclesFor(TICK_US), () => {
      this.fw._sim_tick();
      this.armTick();
    });
  }

  console(text) { for (const ch of text) this.fw._sim_console(ch.charCodeAt(0)); }

  // the start-up's state (sb_state_t in pico/src/sb/sb.h)
  state() { return STATES[this.fw._sim_state()] ?? 'unknown'; }

  // ---- sockets for the firmware's TCP
  newConn(sock) {
    const id = this.nextId++;
    const c = { sock, open: !!sock, error: null, rx: [], eof: false };
    this.conns.set(id, c);
    if (sock) this.wire(c);
    return [id, c];
  }

  wire(c) {
    c.sock.on('data', (d) => c.rx.push(new Uint8Array(d)));
    c.sock.on('end', () => { c.eof = true; });
    c.sock.on('error', (e) => { c.error = e.code || e.message; });
    c.sock.on('close', () => { c.eof = true; });
  }

  tcpOpen(host, port) {
    const [id, c] = this.newConn(null);
    c.sock = net.connect({ host, port });
    c.sock.setNoDelay(true);
    c.sock.on('connect', () => { c.open = true; });
    this.wire(c);
    return id;
  }

  tcpRecv(id, max) {
    const c = this.conns.get(id);
    if (!c) return -2;
    if (!c.rx.length) return c.error ? -2 : c.eof ? 0 : -1;
    const head = c.rx[0];
    if (head.length <= max) { c.rx.shift(); return head; }
    c.rx[0] = head.subarray(max);
    return head.subarray(0, max);
  }

  tcpSend(id, bytes) {
    const c = this.conns.get(id);
    if (!c || !c.open || c.error || c.sock.writableLength > 65536) return 0;
    c.sock.write(bytes);
    return bytes.length;
  }

  resolve(name) {
    const id = this.nextId++;
    const r = { pending: true, ip: null };
    this.resolves.set(id, r);
    dns.lookup(name, { family: 4 }, (err, addr) => {
      r.pending = false;
      r.ip = err ? false : new Uint8Array(addr.split('.').map(Number));
    });
    return id;
  }

  listen(port) {
    const lid = this.nextId++;
    const q = [];
    this.servers.set(lid, q);
    const srv = net.createServer((sock) => { sock.setNoDelay(true); q.push(this.newConn(sock)[0]); });
    srv.on('error', (e) => this.log(`[pico] can't listen on 127.0.0.1:${port}: ${e.code || e.message}`));
    srv.listen(port, '127.0.0.1');
    srv.unref();
    return lid;
  }

  close() {
    for (const c of this.conns.values()) if (c.sock) c.sock.destroy();
    if (this.trace) { this.flushTrace(); closeSync(this.trace.fd); this.trace = null; }
  }
}
