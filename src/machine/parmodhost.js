// PARMOD (PARallel MODem) link, bridge side (WEBTV_LPT_BRIDGE.md §4.1): the emulated bridge's half of the
// box's src/lptmodem/parmod.js. A parallel-port peripheral (attach with
// lptBridge.setConsole(host)); its ends are plain queues and callbacks, so the modem and the
// console, or the stress harness, plug in the same way:
//
//   const pm = new ParmodHost(machine, { modemOut, consoleOut, onCommand });
//   pm.modemIn.push(...bytes); pm.consoleIn.push(...bytes); pm.kick();   towards the box
//   modemOut(byte) -> true taken, false full (refused; call pm.modemRoom() when there's room)
//   consoleOut(byte)                     always taken
//   onModemTaken()                       the box took a modem byte (room in modemIn again)
//   onCommand(code, arg)                 DTR, MODEM_RESET, LEGACY_ECP (arg = its request byte)
//   pm.setCarrier(on)
//
// Timing: answers come at once unless `delays` says otherwise: { ack(code) -> cycles before
// Busy goes high, release(code) -> cycles before it drops }. The box waits for both.

import { CTRL, STAT } from '../lptmodem/link.js';
import { CODE, ST, PMCMD, ENTER_SIG, PARMOD_VERSION } from '../lptmodem/parmod.js';

const NAME = Object.fromEntries(Object.entries(CODE).map(([k, v]) => [v, k]));

export class ParmodHost {
  constructor(machine, { modemOut = () => true, consoleOut = () => {}, onCommand = () => {}, onModemTaken = () => {}, onSession = null, delays = null } = {}) {
    Object.assign(this, { m: machine, modemOut, consoleOut, onCommand, onModemTaken, onSession, delays });
    this.modemIn = []; this.consoleIn = []; this.replies = [];
    this.carrier = false; this.client = false;
    this.stats = { xfers: {}, statusOnly: {}, delayed: 0, refused: 0, attention: 0, sessions: 0, commands: 0 };
    this.port = null;
    this.reset();
  }

  reset() {
    this.session = false;
    this.sig = 0;
    this.argFor = null;           // a command waiting for its argument byte (LEGACY_ECP rq)
    this.busy = false; this.sel = false; this.ackLow = false; this.drive = null;
    this.pending = null;          // the transaction under way: { code, onRise }
    this.full = false;            // refused modem output since the last room
    this.lastFault = true;
  }

  // ---- lines
  get waiting() { return this.modemIn.length > 0 || this.consoleIn.length > 0 || this.replies.length > 0; }
  get statusByte() {
    return (this.modemIn.length ? ST.MODEM : 0) | (this.consoleIn.length ? ST.CONIN : 0) | (this.replies.length ? ST.REPLY : 0)
      | (this.carrier ? ST.CARRIER : 0) | (this.full ? ST.MFULL : 0) | (this.client ? ST.CLIENT : 0);
  }
  get status() {
    return (this.busy ? STAT.BUSY : 0) | (this.ackLow ? 0 : STAT.ACK_N) | (this.session && this.waiting ? 0 : STAT.FAULT_N)
      | (this.sel ? STAT.SEL : 0) | (this.session ? 0 : STAT.PE);
  }
  get data() { return this.drive; }

  update() { if (this.port) this.port.update(); }

  // nAck low pulse: the box's ACKDONE interrupt
  attention() {
    this.stats.attention++;
    this.ackLow = true; this.update();
    this.ackLow = false; this.update();
  }

  // something new for the box: pulse if nFault just went low
  kick() {
    const fault = !(this.session && this.waiting);
    if (this.lastFault && !fault) this.attention();
    this.lastFault = fault;
    this.update();
  }

  setCarrier(on) { if (on === this.carrier) return; this.carrier = on; if (this.session) this.attention(); }

  // the modem side has room again after a refusal
  modemRoom() { if (!this.full) return; this.full = false; if (this.session) this.attention(); }

  // ---- strobes
  hostChanged(port, old, c) {
    this.port = port;
    const fell = (old & CTRL.STB_N) && !(c & CTRL.STB_N), rose = !(old & CTRL.STB_N) && (c & CTRL.STB_N);
    if (fell) this.strobe(port, c);
    else if (rose && this.pending) this.release();
  }

  strobe(port, c) {
    if (this.pending) return;           // a strobe before the last one ended: ignore it
    const code = ((c & CTRL.SELIN_N) ? 4 : 0) | ((c & CTRL.INIT_N) ? 2 : 0) | ((c & CTRL.AUTOFD_N) ? 1 : 0);
    const data = port.driving ? port.data : null;
    let sel = true, drive = null, onRise = null;
    if (!this.session) {
      if (code !== CODE.CTRL_OUT) return; // AUTO: only the entry signature gets an answer,
      sel = this.command(data);         // and only its bytes are "taken" (Select high)
    } else {
      switch (code) {
        case CODE.CTRL_OUT: this.command(data); break;
        case CODE.CTRL_IN: [sel, drive, onRise] = this.give(this.replies); break;
        case CODE.MODEM_IN: [sel, drive, onRise] = this.give(this.modemIn, this.onModemTaken); break;
        case CODE.CON_IN: [sel, drive, onRise] = this.give(this.consoleIn); break;
        case CODE.MODEM_OUT:
          sel = data != null && this.modemOut(data);
          if (!sel) { this.full = true; this.stats.refused++; }
          break;
        case CODE.CON_OUT: if (data != null) this.consoleOut(data); break;
        default: return;                // IDLE and 000 never strobe
      }
    }
    this.stats.xfers[NAME[code]] = (this.stats.xfers[NAME[code]] || 0) + 1;
    this.pending = { code, onRise };
    const answer = () => { this.sel = sel; this.drive = drive; this.busy = true; this.update(); };
    const wait = this.delays ? this.delays.ack(code) : 0;
    if (this.trace) this.trace({ t: this.m.cpu.cycles, code: NAME[code], sel, byte: drive ?? data, wait });
    if (wait > 0) { this.stats.delayed++; this.m.sched.after('parmod-ack', wait, answer); } else answer();
  }

  // an _IN code: the next byte with Select high, or the status byte with Select low
  give(queue, after) {
    if (queue.length) return [true, queue[0], () => { queue.shift(); if (after) after(); }];
    this.stats.statusOnly.n = (this.stats.statusOnly.n || 0) + 1;
    return [false, this.statusByte, null];
  }

  release() {
    const p = this.pending;
    if (!this.busy) { // the box let go before the answer: it gave up on this transaction
      if (!p.gaveUp && this.trace) this.trace({ t: this.m.cpu.cycles, code: 'GAVE-UP', sel: false, wait: 0, pc: this.m.cpu.curPC >>> 0, regs: [...this.m.cpu.gprL.slice(8, 12)].map((r) => (r >>> 0).toString(16)) });
      p.gaveUp = true;
      this.m.sched.after('parmod-rel', 50, () => this.release());
      return;
    }
    this.drive = null;
    if (p.onRise) p.onRise();
    const done = () => { this.busy = false; this.sel = false; this.pending = null; this.kick(); };
    const wait = this.delays ? this.delays.release(p.code) : 0;
    if (wait > 0) this.m.sched.after('parmod-rel', wait, done); else done();
  }

  // CTRL_OUT bytes: the entry signature (any time), else a command. -> true if taken.
  // onCommand(code, arg): arg only for LEGACY_ECP (its request byte, sent next)
  command(b) {
    if (this.session && this.argFor !== null) { const c = this.argFor; this.argFor = null; this.onCommand(c, b); return true; }
    if (b === ENTER_SIG[this.sig]) {
      if (++this.sig === ENTER_SIG.length) {
        this.sig = 0;
        if (!this.session) { this.stats.sessions++; if (this.onSession) this.onSession(true); }
        this.session = true;
        this.replies.push(PARMOD_VERSION);
      }
      return true;
    }
    this.sig = b === ENTER_SIG[0] ? 1 : 0;
    if (!this.session) return this.sig === 1; // outside a session only the signature counts
    this.stats.commands++;
    if (b === PMCMD.LEGACY_ECP) { this.argFor = b; return true; }
    if (b === PMCMD.EXIT) { this.session = false; this.replies.length = 0; if (this.onSession) this.onSession(false); }
    this.onCommand(b);
    return true;
  }
}
