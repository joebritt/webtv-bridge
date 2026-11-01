#!/usr/bin/env node
// PARMOD stress test: the real box-side MIPS (src/lptmodem/parmod.js) on the emulated CPU,
// against the emulated bridge (src/machine/parmodhost.js), with random monkeys at both ends.
//
// Four byte streams run at once, each from its own seeded generator, and every byte is checked
// on arrival, so loss, duplication, reordering or mixing up channels fails at once:
//   A  modem   box -> bridge     the box's transmit ring; the bridge's modem side takes bytes
//                                at random rates and refuses them when its queue is full
//   B  modem   bridge -> box     queued in the bridge; the box's receive ring is drained at
//                                random rates, so it fills and the bridge has to hold on
//   C  console box -> bridge     the driver's console ring; the bridge always takes it
//   D  console bridge -> box     queued in the bridge; drained from the driver's console ring
// Plus: commands from the box (DTR on/off, checked in order), carrier changes from the bridge
// (the box's last status must agree at the end), and random answer delays on the bridge's
// Busy (both edges) up to 150 us. Run lengths are random too: the box pumps when a "driver
// call" asks it to (as putbuf / getbuf would) or when the bridge pulses nAck.
//
//   node tools/parmodstress.mjs [--seed N] [--runs K] [--seconds S] [--quiet]
//
// A failure prints the seed and where; --seed N replays it.
import { readFileSync } from 'node:fs';
import { WebTV } from '../src/machine/webtv.js';
import { ParmodHost } from '../src/machine/parmodhost.js';
import { parmodSource, V, MASK, PMCMD, ST } from '../src/lptmodem/parmod.js';
import { parse, prepare, unitSize, unitLabels, assemble, evaluate } from '../src/lptmodem/asm.js';
import { disasm } from '../src/cpu/disasm.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const quiet = args.includes('--quiet');
const BASE = 0xa0400000, RCV_BUF = 0xa0500000, XMT_BUF = 0xa0501000;
// the box-side monkey asks for a pump at least every few slices (as the OS would on its own output),
// so console output that waits longer than this has been starved by the other channels
const CONSOLE_LIMIT_MS = 40;

// ---------------------------------------------------------------- the box-side program
function buildHarness() {
  const src = parmodSource({ rcvData: 'T_RCVDATA', rcvHead: 'T_RCVHEAD', rcvTail: 'T_RCVTAIL', xmtData: 'T_XMTDATA', xmtHead: 'T_XMTHEAD', xmtTail: 'T_XMTTAIL', ppp: 'T_PPP' }) + `
# the stand-in for the OS: pump when a "driver call" asks (mailbox) or the bridge pulses nAck
.func t_main
  mfc0 t0, 12
  li   t1, -2
  and  t0, t0, t1
  mtc0 t0, 12
  nop
  nop
  lui  sp, 0xa04f
  lui  t9, PPB
  li   t0, 1
  sw   t0, 0x422c(t9)              # ENABLE
  sw   zero, 0x420c(t9)            # CNFG: software mode
  sw   zero, 0x4220(t9)            # IEN: polled
  li   t0, 0x0f
  sw   t0, P_CTRL(t9)
  li   t0, 8
  sw   t0, 0x4228(t9)              # CLRINT ACKDONE
t_loop:
  la   s0, T_MB
  lw   t0, 4(s0)                   # a command (+1) to send
  beqz t0, t_pumpreq
  nop
  sw   zero, 4(s0)
  jal  pm_cmd
  addiu a0, t0, -1
t_pumpreq:
  lw   t0, 0(s0)
  bnez t0, t_pump
  lui  t9, PPB
  lw   t0, 0x4224(t9)              # IST
  andi t0, t0, 8
  beqz t0, t_loop
  nop
  li   t0, 8
  sw   t0, 0x4228(t9)              # the "interrupt": clear ACKDONE, pump
t_pump:
  sw   zero, 0(s0)
  jal  pm_pump
  nop
  lw   t0, 8(s0)
  addiu t0, t0, 1
  b    t_loop
  sw   t0, 8(s0)
.endfunc

.func T_PPP
  la   t0, T_MB
  lw   t1, 12(t0)
  addiu t1, t1, 1
  jr   ra
  sw   t1, 12(t0)
.endfunc

.func T_MB                         # pump request, command + 1, pumps, PPP wake-ups
  .word 0
  .word 0
  .word 0
  .word 0
T_RCVDATA:
  .word ${RCV_BUF}
T_RCVHEAD:
  .word 0
T_RCVTAIL:
  .word 0
T_XMTDATA:
  .word ${XMT_BUF}
T_XMTHEAD:
  .word 0
T_XMTTAIL:
  .word 0
.endfunc
`;
  const prog = parse(src, 'parmodstress');
  const labels = new Map();
  const lookup = (n) => (labels.has(n) ? labels.get(n) : prog.equ.has(n) ? evaluate(prog.equ.get(n), lookup, n) ?? undefined : undefined);
  for (const u of prog.units) prepare(u, lookup);
  // t_main first, so the program starts at BASE
  const units = [...prog.units.filter((u) => u.name === 't_main'), ...prog.units.filter((u) => u.name !== 't_main')];
  let at = BASE;
  const placed = units.map((u) => { const p = { u, at }; for (const [k, v] of unitLabels(u, at)) labels.set(k, v); at += unitSize(u); return p; });
  const bytes = new Uint8Array(at - BASE);
  for (const { u, at: a } of placed) bytes.set(assemble(u, a, lookup), a - BASE);
  return { bytes, labels };
}

// ---------------------------------------------------------------- helpers
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
class Stream { // a seeded byte sequence, produced and checked in order, with each byte's latency
  constructor(name, seed, clock) {
    Object.assign(this, { name, clock, gen: mulberry32(seed), check: mulberry32(seed), made: 0, seen: 0, born: [], worst: 0, sum: 0 });
  }
  next() { this.made++; this.born.push(this.clock()); return Math.floor(this.gen() * 256); }
  verify(b) {
    const want = Math.floor(this.check() * 256);
    if (b !== want) throw new Error(`stream ${this.name}: byte ${this.seen} is ${b}, expected ${want}`);
    const age = this.clock() - this.born.shift();
    this.worst = Math.max(this.worst, age); this.sum += age;
    this.seen++;
  }
}

class Failure extends Error {}

function runOnce(seed, seconds, program) {
  const rnd = mulberry32(seed);
  const pick = (n) => Math.floor(rnd() * n);
  const chance = (p) => rnd() < p;
  const m = new WebTV({ rom: readFileSync('data/flipped_merged_boot.bin'), disk: null, log: () => {} });
  const us = (n) => Math.round(n * m.cpuHz / 1e6);

  // RAM access (the program and its rings are in kseg1)
  const ram = m.bus.ram;
  const phys = (a) => a & 0x1fffffff;
  const r32 = (a) => ram[phys(a) >>> 2] >>> 0;
  const w32 = (a, v) => { ram[phys(a) >>> 2] = v >>> 0; };
  const r8 = (a) => (ram[phys(a) >>> 2] >>> (24 - 8 * (a & 3))) & 0xff;
  const w8 = (a, v) => { const i = phys(a) >>> 2, sh = 24 - 8 * (a & 3); ram[i] = ((ram[i] & ~(0xff << sh)) | ((v & 0xff) << sh)) >>> 0; };
  for (let i = 0; i < program.bytes.length; i += 4) w32(BASE + i, (program.bytes[i] << 24) | (program.bytes[i + 1] << 16) | (program.bytes[i + 2] << 8) | program.bytes[i + 3]);
  const L = (n) => program.labels.get(n);
  const VARS = L('PM_VARS'), MB = L('T_MB');

  const clock = () => m.cpu.cycles / m.cpuHz * 1000; // ms
  const A = new Stream('A (modem, box to bridge)', seed * 4 + 1, clock), B = new Stream('B (modem, bridge to box)', seed * 4 + 2, clock);
  const C = new Stream('C (console, box to bridge)', seed * 4 + 3, clock), D = new Stream('D (console, bridge to box)', seed * 4 + 4, clock);

  // ---- the bridge, with its monkey
  let modemLimit = 64, carrier = false;
  const fromBox = [];
  const sentCmds = [], gotCmds = [];
  const maxDelay = { ack: us(150), release: us(150) };
  const delay = () => (chance(0.7) ? 0 : chance(0.85) ? pick(us(30)) : pick(maxDelay.ack));
  const host = new ParmodHost(m, {
    modemOut: (b) => { if (fromBox.length >= modemLimit) return false; fromBox.push(b); return true; },
    consoleOut: (b) => C.verify(b),
    onCommand: (b) => gotCmds.push(b),
    delays: args.includes('--no-delays') ? null : { ack: delay, release: delay },
  });
  m.lptBridge.setConsole(host);
  const recent = [];
  host.trace = (x) => { recent.push(x); if (recent.length > 30) recent.shift(); };

  // ---- the box: start the program
  m.cpu.pc = BASE | 0; m.cpu.npc = (BASE + 4) | 0;
  if (process.env.DEBUGWIN) { // DEBUGWIN=from,to (cycles): print each instruction the box runs
    const [from, to] = process.env.DEBUGWIN.split(',').map(Number);
    {
      m.cpu.traceHook = (pc, op) => { const c = m.cpu.cycles; if (c >= from && c <= to) console.log(c, (pc >>> 0).toString(16), disasm(op, pc), 't0', (m.cpu.gprL[8] >>> 0).toString(16), 't1', (m.cpu.gprL[9] >>> 0).toString(16), 't3', (m.cpu.gprL[11] >>> 0).toString(16), 'count', (m.cpu.getCount() >>> 0).toString(16)); };
    }
  }

  const ring = (head, tail, mask) => ({ used: (r32(head) - r32(tail)) & mask, free: (r32(tail) - r32(head) - 1) & mask });
  let producing = true, stats = { slices: 0 };
  const boxMonkey = () => {
    if (producing && chance(0.5)) { // the OS writes modem bytes (putbuf), usually followed by a pump
      const { free } = ring(L('T_XMTHEAD'), L('T_XMTTAIL'), MASK.MODEM);
      for (let n = Math.min(free, pick(300)); n > 0; n--) { const h = (r32(L('T_XMTHEAD')) + 1) & MASK.MODEM; w8(XMT_BUF + h, A.next()); w32(L('T_XMTHEAD'), h); }
      if (chance(0.8)) w32(MB, 1);
    }
    if (producing && chance(0.4)) { // console output
      const { free } = ring(VARS + V.COH, VARS + V.COT, MASK.CONOUT);
      for (let n = Math.min(free, pick(120)); n > 0; n--) { const h = (r32(VARS + V.COH) + 1) & MASK.CONOUT; w8(VARS + V.COD + h, C.next()); w32(VARS + V.COH, h); }
      if (chance(0.8)) w32(MB, 1);
    }
    if (chance(0.5)) { // PPP reads the receive ring (getbuf), and usually pumps after
      const { used } = ring(L('T_RCVHEAD'), L('T_RCVTAIL'), MASK.MODEM);
      for (let n = producing ? Math.min(used, pick(400)) : used; n > 0; n--) { const t = (r32(L('T_RCVTAIL')) + 1) & MASK.MODEM; B.verify(r8(RCV_BUF + t)); w32(L('T_RCVTAIL'), t); }
      if (chance(producing ? 0.7 : 1)) w32(MB, 1);
    }
    if (chance(0.4)) { // the console reads its input
      const { used } = ring(VARS + V.CIH, VARS + V.CIT, MASK.CONIN);
      for (let n = producing ? Math.min(used, pick(64)) : used; n > 0; n--) { const t = (r32(VARS + V.CIT) + 1) & MASK.CONIN; D.verify(r8(VARS + V.CID + t)); w32(VARS + V.CIT, t); }
      if (chance(0.5)) w32(MB, 1);
    }
    if (producing && chance(0.03) && r32(MB + 4) === 0) { // DTR on / off
      const c = chance(0.5) ? PMCMD.DTR_ON : PMCMD.DTR_OFF;
      sentCmds.push(c); w32(MB + 4, c + 1);
    }
  };
  const bridgeMonkey = () => {
    if (producing && chance(0.4) && host.modemIn.length < 3000) { for (let n = pick(400); n > 0; n--) host.modemIn.push(B.next()); host.kick(); }
    if (producing && chance(0.2) && host.consoleIn.length < 500) { for (let n = pick(80); n > 0; n--) host.consoleIn.push(D.next()); host.kick(); }
    if (chance(0.5)) { // the modem side takes bytes at its own pace
      for (let n = producing ? pick(200) : fromBox.length; n > 0 && fromBox.length; n--) A.verify(fromBox.shift());
      if (fromBox.length < modemLimit) host.modemRoom();
    }
    if (chance(0.05)) modemLimit = [1, 4, 16, 64, 512][pick(5)];
    if (producing && chance(0.02)) { carrier = !carrier; host.setCarrier(carrier); }
  };

  const end = seconds * m.cpuHz;
  try {
    for (;;) { // produce until `end`, then drain until everything has arrived
      if (producing && m.cpu.cycles >= end) producing = false;
      m.run(10000 + pick(400000));
      stats.slices++;
      if (r32(VARS + V.ERRS)) throw new Failure('the box got no answer to a transaction');
      boxMonkey();
      bridgeMonkey();
      if (!producing) {
        // drain: everything made must arrive
        const left = A.made - A.seen + B.made - B.seen + C.made - C.seen + D.made - D.seen;
        if (!left && r32(MB + 4) === 0) break;
        if (m.cpu.cycles > end + 5 * m.cpuHz) throw new Failure(`drain stalled: A ${A.made - A.seen}, B ${B.made - B.seen}, C ${C.made - C.seen}, D ${D.made - D.seen} bytes still in flight`);
      }
    }
    // final pump so the box sees the last carrier change
    w32(MB, 1); m.run(us(20000));
    if (JSON.stringify(gotCmds) !== JSON.stringify(sentCmds)) throw new Failure(`commands: sent ${sentCmds.length}, bridge got ${gotCmds.length} (${JSON.stringify(gotCmds.slice(0, 8))})`);
    const status = r32(VARS + V.STATUS);
    if (!!(status & ST.CARRIER) !== carrier) throw new Failure(`carrier: bridge ${carrier}, box last saw ${!!(status & ST.CARRIER)}`);
    const errs = r32(VARS + V.ERRS);
    if (errs) throw new Failure(`${errs} transactions got no answer`);
    // console output goes out on every pump, whatever the modem is doing: a stall means it waited behind it
    if (C.worst > CONSOLE_LIMIT_MS) throw new Failure(`console output waited ${C.worst.toFixed(1)} ms (limit ${CONSOLE_LIMIT_MS})`);
  } catch (e) {
    e.message = `seed ${seed}: ${e.message} (at ${(m.cpu.cycles / m.cpuHz).toFixed(3)} s emulated; box: ${r32(VARS + V.ERRS)} unanswered, ${r32(VARS + V.ENTERS)} entries, command queue ${r32(VARS + V.CMT)}..${r32(VARS + V.CMH)}, mailbox ${r32(MB + 4)}, session ${r32(VARS + V.SESSION)} busy ${r32(VARS + V.BUSY)} failed ${r32(VARS + V.FAILED)})`;
    if (args.includes('--trace')) e.message += '\n' + recent.map((x) => `  ${x.t} ${x.code.padEnd(9)} ${x.sel ? 'sel ' : '    '}${String(x.byte ?? '').padEnd(4)} ${x.wait ? 'answer after ' + x.wait : ''}${x.pc ? ` pc ${x.pc.toString(16)} (${[...program.labels].filter(([, a]) => a <= x.pc).sort((p, q) => q[1] - p[1])[0].join('+')}) t0-t3 ${x.regs.join(' ')}` : ''}`).join('\n');
    throw e;
  }
  const lat = (x) => `${(x.sum / Math.max(1, x.seen)).toFixed(1)}/${x.worst.toFixed(1)}`;
  return { lat: `latency ms (mean/worst) A ${lat(A)} B ${lat(B)} C ${lat(C)} D ${lat(D)}`, statusOnly: host.stats.statusOnly.n || 0, delayed: host.stats.delayed,
    A: A.seen, B: B.seen, C: C.seen, D: D.seen, cmds: sentCmds.length, xfers: host.stats.xfers, refused: host.stats.refused,
    attention: host.stats.attention, pumps: r32(MB + 8), ppp: r32(MB + 12), sessions: host.stats.sessions, secs: m.cpu.cycles / m.cpuHz, slices: stats.slices };
}

// ---------------------------------------------------------------- runs
const program = buildHarness();
const first = Number(opt('seed', 1)), runs = Number(opt('runs', opt('seed') ? 1 : 10)), seconds = Number(opt('seconds', 2));
let total = { bytes: 0, xfers: 0 }, failed = 0;
const t0 = Date.now();
for (let seed = first; seed < first + runs; seed++) {
  try {
    const r = runOnce(seed, seconds, program);
    const xf = Object.values(r.xfers).reduce((a, b) => a + b, 0);
    total.bytes += r.A + r.B + r.C + r.D; total.xfers += xf;
    if (!quiet) console.log(`seed ${seed}: ok  ${r.secs.toFixed(2)} s  A ${r.A}  B ${r.B}  C ${r.C}  D ${r.D} bytes; ${r.cmds} commands; ${xf} transactions (${Object.entries(r.xfers).map(([k, v]) => `${k} ${v}`).join(', ')}); ${r.statusOnly} answered with the status; ${r.delayed} delayed; ${r.refused} refused; ${r.attention} nAck; ${r.pumps} pumps\n    ${r.lat}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${e.message}`);
  }
}
console.log(`${runs - failed}/${runs} runs passed; ${total.bytes} bytes checked over ${total.xfers} transactions (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
