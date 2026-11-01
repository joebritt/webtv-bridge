// SOLO1 devUnit IR receiver (DEV_IROLD, DEV_IRIN_SAMPLE/REJECT_INT/TRANS_DATA/STATCNTL) with a
// Sejin IR keyboard encoder feeding it. All user input on the WebTV Plus (remote and keyboard)
// arrives here as a stream of IR transitions that the OS decodes in software.
//
// Ported from the wtvemac MAME driver (wtvir.cpp / wtvir.h, "SEJIN_KBD" wtvir_sejin_device,
// BSD-3-Clause, copyright-holders FairPlay137, wtvemac).
//
// Behaviour (as in MAME):
//  - Key events are queued as 22-bit Sejin packets.
//  - A 60 Hz poll raises DEV_INT_IRIN whenever a packet is waiting and the OS has not read
//    DEV_IRIN_TRANS_DATA since the last trigger.
//  - Each DEV_IRIN_TRANS_DATA read returns one run of equal bits from the current packet:
//      SSSS | V | TTTTTTTTTTT   (FIFO entries left, bit value, duration in sample clocks)
//    and 0 when nothing is queued. The last run queued (the line going idle) is reported when
//    the next transmission's first edge ends it, or at the counter's maximum (2047 ticks,
//    ~31 ms) once the line has been idle that long; that long run is what resets the OS's
//    decoders between presses.
//
// Not in MAME: runs take real (emulated) time. Each becomes readable only once it has ended,
// one every ~0.7 ms for the keyboard, as a receiver delivers them; MAME hands a whole packet
// over at once, which a reader faster than the OS's 60 Hz interrupt (the stock-box loader)
// would see as an impossible burst. Transmissions are at least IDLE_US apart, and the idle
// line lengthens the run it continues (up to the 11-bit maximum), as it would on a receiver.
//
// Not in MAME: the WebTV remote (pressRemote). Its frames are built from the OS's own decoder
// (DecodeEchoStar, "WebTV (mod EchoStar)"): a gap of ~5.9 ms, then 13 bits, each a ~550 us
// low run and a high run of ~2.6 ms (0) or ~1.5 ms (1); the bits are key:6 address:5 (0)
// type:2 (0 press, 3 release). Queue entries are lists of runs, so both kinds share the FIFO.
//
// Also Sony's WebTV remote (pressRemote('sony-up') and so on), as the OS's DecodeSony takes it:
// 20-bit SIRC frames, 45 ms apart, three to a press (a press posts on two equal frames, and the
// gap after the second must be a real one, not the idle line). The device and extended bits are
// made up: the OS doesn't look at them.

import { DEV_INT_IRIN } from './solo.js';
import { REMOTE, KEY_MAP, CHAR_KEYS } from '../../web/irkeys.js';
export { REMOTE, KEY_MAP, CHAR_KEYS };

const POLL_HZ = 60;
const MAX_SAMPLE_FIFO_ENTRIES = 0x10;
const DEFAULT_BIT_SAMPLE_CLOCKS = 48;
const IR_MICROCODE_VERSION = 0x69;
const SEJIN_DEFAULT_IR_DATA = 0x200508;
const SEJIN_DATA_BIT_COUNT = 22;
const SEJIN_DEVICE_ID = 0x01;
const MAX_QUEUE = 256;
const US_PER_TICK = 15;            // the sample interval the OS sets (SetSampleInterval(15))
const RC = { off: 550, gap: 5900, zero: 2600, one: 1480 }; // inside the OS's kE_T* windows
const IDLE_US = 20000;             // between transmissions (keyboard packets)
const REMOTE_IDLE_US = 200000;     // between remote presses: a person's pace (the OS takes the
                                   // same code within ~117 ms as a held button)
const MAX_TICKS = 0x7ff;
const SONY_T = { guide: 2400, off: 600, zero: 600, one: 1200, frame: 45000, frames: 3, device: 0x1a, ext: 0x00 };

// Sony's WebTV remote button -> 7-bit command (the OS's Table.2492, Sony_ParseAndPost)
export const SONY_REMOTE = {
  up: 0x74, down: 0x75, left: 0x34, right: 0x33, select: 0x65, enter: 0x0b, back: 0x4c, home: 0x62,
  options: 0x61, recent: 0x4b, scroll_up: 0x58, scroll_down: 0x59, power: 0x15, view: 0x5c,
  '1': 0x00, '2': 0x01, '3': 0x02, '4': 0x03, '5': 0x04, '6': 0x05, '7': 0x06, '8': 0x07, '9': 0x08, '0': 0x09,
};

// a Sony press -> runs: SONY_T.frames frames, each padded with a gap to SONY_T.frame
export function sonyRuns(cmd) {
  const t = (us) => Math.round(us / US_PER_TICK), T = SONY_T, runs = [];
  const bits = (cmd & 0x7f) | ((T.device & 0x1f) << 7) | ((T.ext & 0xff) << 12);
  for (let f = 0; f < T.frames; f++) {
    let us = T.guide;
    runs.push([0, t(T.guide)]);
    for (let i = 0; i < 20; i++) {
      const on = (bits >> i) & 1 ? T.one : T.zero;
      runs.push([1, t(T.off)], [0, t(on)]);
      us += T.off + on;
    }
    runs.push([1, t(T.frame - us)]);
  }
  return runs;
}

// Sejin packet -> runs of equal bits, bit 0 first, DEFAULT_BIT_SAMPLE_CLOCKS a bit
function sejinRuns(data) {
  const runs = [];
  for (let i = 0; i < SEJIN_DATA_BIT_COUNT; i++) {
    const bit = (data >>> i) & 1, last = runs[runs.length - 1];
    if (last && last[0] === bit) last[1] += DEFAULT_BIT_SAMPLE_CLOCKS; else runs.push([bit, DEFAULT_BIT_SAMPLE_CLOCKS]);
  }
  return runs;
}

// WebTV remote press and release -> runs (see the header)
export function remoteRuns(code) {
  const t = (us) => Math.round(us / US_PER_TICK);
  const runs = [[0, t(RC.off)], [1, t(RC.gap)]];
  for (const type of [0, 3]) {
    const bits = ((code & 0x3f) << 7) | type;
    for (let i = 12; i >= 0; i--) runs.push([0, t(RC.off)], [1, t((bits >> i) & 1 ? RC.one : RC.zero)]);
    runs.push([0, t(RC.off)], [1, t(RC.gap)]);
  }
  return runs; // ends on a gap: the line then idles high
}

// Remote-control style buttons (sent as the equivalent Sejin keyboard keys).
export const BUTTONS = {
  power: 0x1b, up: 0x4b, down: 0x50, left: 0x48, right: 0x58, select: 0x3a, enter: 0x3a,
  back: 0x4e, home: 0x3c, options: 0x54, recent: 0x5c, view: 0x05, scroll_up: 0x56, scroll_down: 0x5b,
  search: 0x3d, favorites: 0x64, mail: 0x55, info: 0x52, goto: 0x2d, send: 0x2f, save: 0x4a,
  edit: 0x4c, find: 0x5d, cmd: 0x1c, channel_up: 0x37, channel_down: 0x36, space: 0x38,
  '0': 0x6d, '1': 0x1d, '2': 0x0d, '3': 0x15, '4': 0x25, '5': 0x24, '6': 0x7c, '7': 0x7d, '8': 0x75, '9': 0x65,
};
export const BUTTON_NAMES = Object.keys(BUTTONS);

function oddParity(data, start, count) {
  let n = 0;
  for (let i = start; i < start + count; i++) if (data & (1 << i)) n++;
  return n & 1;
}

// [1 P 0 SSSSSSS 0] [1 P 1 M DD 0100 0]  (bit 0 on the right; M=1 for key release)
export function sejinPacket(scancode, release) {
  let d = SEJIN_DEFAULT_IR_DATA;
  d |= (SEJIN_DEVICE_ID & 3) << 5;
  d |= (scancode & 0x7f) << 12;
  d |= (release ? 1 : 0) << 7;
  d |= oddParity(d, 0, 11) << 9;
  d |= oddParity(d, 11, 11) << 20;
  return d;
}

export class SoloIr {
  constructor(machine) {
    this.m = machine;
    this.queue = []; // runs in time order: {level, ticks, end (CPU cycle), hold (the idle tail)}
    this.cyclesPerTick = machine.cpuHz * US_PER_TICK / 1e6;
    this.down = new Set();
    this.seq = 0;
    this.reset();
  }

  reset() {
    this.queue.length = 0;
    this.lineFreeAt = 0;
    this.idleAfter = IDLE_US;
    this.down.clear();
    this.waitingForRead = false;
    this.oldValue = IR_MICROCODE_VERSION << 16;
    this.sampleInterval = 0;
    this.rejectInterval = 0;
    this.statcntl = 0;
    this.pollScheduled = false;
    this.m.sched.cancel('ir-poll');
  }

  // ---------------------------------------------------------------- register interface

  readIrOld() { return this.oldValue; }

  read(o) {
    switch (o) {
      case 0x20: return this.sampleInterval & 0xffff;
      case 0x24: return this.rejectInterval & 0xff;
      case 0x28: return this.transData();
      case 0x2c: return this.statcntl & 0xff;
    }
    return 0;
  }

  write(o, v) {
    switch (o) {
      case 0x20: this.sampleInterval = v & 0xffff; return;
      case 0x24: this.rejectInterval = v & 0xff; return;
      case 0x2c:
        this.statcntl = v & 0xff;
        if (this.statcntl & 2) this.statcntl &= ~2; // reset pulse
        return;
    }
  }

  // MAME re-triggers from its poll timer rather than on interrupt clear.
  pending() { return false; }

  // runs that have ended and wait to be read (counting no further than the FIFO reports)
  ready() {
    const now = this.m.cpu.cycles, q = this.queue;
    const tail = q[q.length - 1];
    if (tail && tail.hold) { // idle long enough to fill the run counter: reported at its maximum
      const full = tail.end + (MAX_TICKS - tail.ticks) * this.cyclesPerTick;
      if (now >= full) { tail.ticks = MAX_TICKS; tail.end = full; tail.hold = false; }
    }
    let n = 0;
    while (n < q.length && n < MAX_SAMPLE_FIFO_ENTRIES - 2 && !q[n].hold && q[n].end <= now) n++;
    return n;
  }

  transData() {
    const left = this.ready();
    this.waitingForRead = false;
    if (!left) return 0;
    const { level, ticks } = this.queue.shift();
    return ((left & 0xf) << 12) | (level << 11) | (ticks & 0x7ff);
  }

  // ---------------------------------------------------------------- polling

  schedulePoll() {
    if (this.pollScheduled) return;
    this.pollScheduled = true;
    this.m.sched.after('ir-poll', Math.round(this.m.cpuHz / POLL_HZ), () => {
      this.pollScheduled = false;
      this.poll();
    });
  }

  poll() {
    if (this.ready() && !this.waitingForRead) {
      this.waitingForRead = true;
      this.m.solo.setDevIrq(DEV_INT_IRIN, true);
    }
    if (this.queue.length) this.schedulePoll();
  }

  enqueue(scancode, release) { return this.enqueueRuns(sejinRuns(sejinPacket(scancode, release))); }

  enqueueRuns(runs, idleUs = IDLE_US) {
    if (this.queue.length >= MAX_QUEUE * 32) return false;
    const q = this.queue;
    let t = Math.max(this.m.cpu.cycles, this.lineFreeAt + this.idleAfter * this.cyclesPerTick / US_PER_TICK);
    this.idleAfter = idleUs;
    const tail = q[q.length - 1];
    if (tail && tail.hold) { // this transmission's first edge ends the idle tail
      tail.ticks = Math.min(MAX_TICKS, tail.ticks + Math.round((t - tail.end) / this.cyclesPerTick));
      tail.end = t;
      tail.hold = false;
    }
    for (const [level, ticks] of runs) { t += ticks * this.cyclesPerTick; q.push({ level, ticks, end: t, hold: false }); }
    q[q.length - 1].hold = true;
    this.lineFreeAt = t;
    // A reset event clears the scheduler; make sure the poll is really pending.
    if (!this.m.sched.pending('ir-poll')) this.pollScheduled = false;
    this.schedulePoll();
    return true;
  }

  // ---------------------------------------------------------------- public input API

  /** Press a key given a browser KeyboardEvent.code. Returns true if the key is mapped. */
  keyDown(code) {
    const sc = KEY_MAP[code];
    if (sc === undefined) return false;
    if (this.down.has(sc)) return true; // ignore host auto-repeat, like MAME's port polling
    this.down.add(sc);
    this.enqueue(sc, false);
    return true;
  }

  keyUp(code) {
    const sc = KEY_MAP[code];
    if (sc === undefined) return false;
    if (!this.down.has(sc)) return true;
    this.down.delete(sc);
    this.enqueue(sc, true);
    return true;
  }

  /** Type text on the keyboard (US layout, Shift as needed). Returns false if a character has no key. */
  typeText(text) {
    const keys = [];
    for (const ch of text) {
      const k = CHAR_KEYS[ch];
      if (!k) return false;
      keys.push(k);
    }
    const shift = KEY_MAP.ShiftLeft;
    for (const [code, shifted] of keys) {
      const sc = KEY_MAP[code];
      if (shifted) this.enqueue(shift, false);
      this.enqueue(sc, false);
      this.enqueue(sc, true);
      if (shifted) this.enqueue(shift, true);
    }
    return true;
  }

  /** Press and release a WebTV remote button by name (see REMOTE), as the remote sends it. */
  pressRemote(name) {
    const n = String(name).toLowerCase();
    if (n.startsWith('sony-')) {
      const cmd = SONY_REMOTE[n.slice(5)];
      return cmd === undefined ? false : this.enqueueRuns(sonyRuns(cmd), REMOTE_IDLE_US);
    }
    const code = REMOTE[n];
    if (code === undefined) return false;
    return this.enqueueRuns(remoteRuns(code), REMOTE_IDLE_US);
  }

  /** Press and release a remote button by name (see BUTTON_NAMES), sent as keyboard keys. */
  pressButton(name) {
    const sc = BUTTONS[String(name).toLowerCase()];
    if (sc === undefined) return false;
    this.enqueue(sc, false);
    this.enqueue(sc, true);
    return true;
  }
}
