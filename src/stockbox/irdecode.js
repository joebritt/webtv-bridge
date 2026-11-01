// The bridge's IR decoding for the stock-box loader: the loader forwards the SOLO IR
// receiver's raw runs (protocol.js), and this turns them into keys. It is a port of the
// WebTV OS's own IR stack (build 16406, daily-debug), written to translate line for line into
// C for the Pico:
//
//   InterpretIRSamples   each run -> (level, microseconds) -> every decoder
//   DecodeSejin          the IR keyboard: a 13-state machine over bit cells       -> SejinDecoder
//   DecodeEchoStar       the WebTV remote ("WebTV (mod EchoStar)"): 13-bit frames -> RemoteDecoder
//   DecodeSony           Sony's WebTV remote: 20-bit SIRC, two equal frames      -> SonyDecoder
//   ParseIRKBData / IRKBMake / IRKBBreak, HandleEchoStarIR / EchoStar_ParseAndPost
//                        frames -> keys through the OS's tables                 -> IrKeys
//
// The state machines and their timing windows are the OS's, constant for constant (the k*
// values are its initialised data). The OS turns its Sony and Philips decoders on by the box's
// maker (InitSoloIR); the bridge's screens always take Sony's remote, so it works there on any
// box. Philips (RC-5) is not ported. Remote repeat follows HandleEchoStarIR: a
// frame with the same code within 7 ticks (~117 ms) of the last is part of a hold (that is
// also how the release frame is absorbed), and a held arrow or scroll key repeats after 9
// such frames, then every 3rd. Time is the bridge's clock when the runs arrive (the loader
// forwards them within ms; run lengths alone can't show an idle line). The keyboard is taken
// key by key; its own auto-repeat is not ported.

import { IR_US_PER_TICK } from './protocol.js';

// ---------------------------------------------------------------- keyboard (Sejin)

const SEJIN = {
  bitOffMin: 715, bitOffMax: 1300, bitOnMin: 555, bitOnMax: 810, // kSejinBit{Off,On}{Min,Max}
  bitcell: 771, halfBitcell: 340,                                  // kSejinBitcell, kSejinHalfBitcell
};

export class SejinDecoder {
  // onFrame({ header, code }): header 0x94 = make, 0xd4 = break (ParseIRKBData's input)
  constructor(onFrame) { this.onFrame = onFrame; this.state = 1; this.clear(); }

  clear() { this.header = 0; this.data = 0; this.count = 0; this.parity = 0; this.bit10 = 0; }

  // SejinTestBitTime_0 / _1: a run of `mult` cells at the level, else back to state 1
  test(level, us, want, mult, next) {
    const [min, max] = want ? [SEJIN.bitOnMin, SEJIN.bitOnMax] : [SEJIN.bitOffMin, SEJIN.bitOffMax];
    this.state = level === want && us >= mult * min && us <= mult * max ? next : 1;
  }

  getBit(bit) { // SejinGetBit
    this.data = (this.data >>> 1) | (bit ? 0x80000000 : 0);
    if (bit) this.parity = (this.parity + 1) & 0xff;
    this.count = (this.count + 1) & 0xff;
    if (this.count === 10) this.bit10 = bit;
  }

  validate() { // ValidateSejinData
    const code = (this.data >>> 23) & 0xff;
    if (this.bit10) this.parity = (this.parity - 1) & 0xff;
    const odd = this.parity & 1;
    if ((odd && !this.bit10) || (!odd && this.bit10)) this.onFrame({ header: this.header, code });
  }

  // the rest of a bit run after its first half cell: one bit per whole cell, at most 9
  feed(level, us) {
    switch (this.state) {
      case 1: this.clear(); this.test(level, us, 0, 3, 3); break;
      case 2: this.test(level, us, 0, 3, 3); break;
      case 3: this.test(level, us, 1, 1, 4); break;
      case 4: this.test(level, us, 0, 1, 5); break;
      case 5: this.test(level, us, 1, 1, 6); break;
      case 6: this.test(level, us, 0, 2, 7); if (this.state === 1) this.test(level, us, 0, 1, 10); break;
      case 7: this.test(level, us, 1, 1, 8); break;
      case 8: this.test(level, us, 0, 1, 9); break;
      case 9: this.test(level, us, 1, 1, 11); if (this.state !== 1) this.header = 0x94; break;
      case 10: this.test(level, us, 1, 4, 11); if (this.state !== 1) this.header = 0xd4; break;
      case 11: case 12: {
        if (level !== 0) { this.state = 1; break; }
        // leading zeros of the data: counted, not shifted in (data starts at 0)
        us -= SEJIN.halfBitcell;
        if (us >= SEJIN.bitcell && this.count < 9) {
          for (;;) {
            us -= SEJIN.bitcell;
            this.count++;
            if (us < SEJIN.bitcell || this.count >= 9) break;
          }
        }
        if (this.count === 8) this.getBit(1);
        if (this.count === 9) { this.validate(); this.state = 1; } else this.state = 13;
        break;
      }
      case 13: {
        this.getBit(level);
        us -= SEJIN.halfBitcell;
        if (us >= SEJIN.bitcell) {
          while (this.count < 9) {
            this.getBit(level);
            us -= SEJIN.bitcell;
            if (us < SEJIN.bitcell) break;
          }
        }
        if (this.count === 8) this.getBit(1);
        if (this.count === 9) { this.validate(); this.state = 1; }
        break;
      }
      default: this.state = 1;
    }
  }
}

// ---------------------------------------------------------------- the WebTV remote (EchoStar style)

const REMOTE = {
  offMin: 400, offMax: 705,          // kE_TOff{Min,Max}
  gapMin: 5700, gapMax: 6150,        // kE_TIWG{Min,Max}: the gap between frames
  zeroMin: 2400, zeroMax: 2830,      // kE_TOnZero{Min,Max}
  oneMin: 1340, oneMax: 1630,        // kE_TOnOne{Min,Max}
};

export class RemoteDecoder {
  // onFrame({ key, down }): key is the remote's 6-bit code
  constructor(onFrame) { this.onFrame = onFrame; this.state = 0; this.count = 0; this.bits = 0; }

  feed(level, us) {
    const R = REMOTE;
    const off = level === 0 && us >= R.offMin && us <= R.offMax;
    const gap = level === 1 && us >= R.gapMin && us <= R.gapMax;
    switch (this.state) {
      case 0: this.count = 0; this.bits = 0; // fall through
      case 1: if (off) this.state = 2; break;   // (stays put otherwise)
      case 2: this.state = gap ? 3 : 0; break;
      case 3: this.state = off ? 4 : 0; break;
      case 4:
        if (level === 1 && us >= R.zeroMin && us <= R.zeroMax) this.state = this.update(0);
        else if (level === 1 && us >= R.oneMin && us <= R.oneMax) this.state = this.update(1);
        else this.state = 0;
        break;
      case 5: this.state = off ? 6 : 0; break;
      case 6:
        if (gap) { this.post(); this.state = 3; } else this.state = 0;
        break;
      default: this.state = 0;
    }
  }

  update(bit) { // UpdateEchoStarBits
    this.count++;
    this.bits = ((this.bits << 1) | bit) >>> 0;
    if (this.count === 13) { this.count = 0; return 5; }
    return 3;
  }

  post() { // PostEchoStarBits / PostEchoStar / ValidEchostarStyleRemote
    const key = (this.bits >>> 7) & 0x3f, addr = (this.bits >>> 2) & 0x1f, type = this.bits & 3;
    if (addr === 0 && (type === 0 || type === 3)) this.onFrame({ key, down: type === 0 });
  }
}

// ---------------------------------------------------------------- Sony's WebTV remote (DecodeSony)
// 20-bit SIRC, least significant bit first: a ~2.4 ms mark, then per bit a ~600 us space and a
// mark of ~600 us (0) or ~1200 us (1); command:7 device:5 extended:8. A frame counts only when
// the one after it is the same (ValidateSonyData). Level 0 is a mark.

const SONY = {
  guideMin: 2000, guideMax: 2780,    // kTGuide{Min,Max}: the leading mark
  offMin: 320, offMax: 750,          // kTOff{Min,Max}: the space before each bit
  zeroMin: 450, zeroMax: 880,        // kTOnZero{Min,Max}
  oneMin: 1050, oneMax: 1480,        // kTOnOne{Min,Max}
  gapMin: 8000, gapMax: 26000,       // kTInter20{Min,Max}: after the 20th bit
};

export class SonyDecoder {
  // onFrame({ cmd, device }): two equal frames in a row
  constructor(onFrame) { this.onFrame = onFrame; this.state = 0; this.bits = 0; this.frame = 0; this.data = [0, 0]; }

  feed(level, us) {
    const N = SONY;
    switch (this.state) {
      case 0: this.bits = 0; this.frame = 0; this.data = [0, 0]; // fall through
      case 1: if (level === 0 && us >= N.guideMin && us <= N.guideMax) this.state = 2; break;   // (stays put otherwise)
      case 2: this.state = level === 1 && us >= N.offMin && us <= N.offMax ? 3 : 0; break;
      case 3:
        if (level === 0 && us >= N.zeroMin && us <= N.zeroMax) this.bit(0);
        else if (level === 0 && us >= N.oneMin && us <= N.oneMax) this.bit(1);
        else this.state = 0;
        break;
      case 4:
        if (level !== 1 || us < N.gapMin || us > N.gapMax) { this.state = 0; break; }
        if (this.frame < 2) { this.state = 1; break; }
        if (this.data[0] === this.data[1]) this.onFrame({ cmd: (this.data[0] >>> 12) & 0x7f, device: (this.data[0] >>> 19) & 0x1f });
        this.state = 0;
        break;
      default: this.state = 0;
    }
  }

  bit(b) { // SonyBitUpdate
    this.data[this.frame] = ((this.data[this.frame] >>> 1) | (b ? 0x80000000 : 0)) >>> 0;
    if (++this.bits === 20) { this.bits = 0; this.state = 4; this.frame++; } else this.state = 2;
  }
}

// ---------------------------------------------------------------- frames -> keys

// The OS's key values: printable ASCII, control characters, and 0x80xx for the WebTV keys
export const KEY_NAMES = {
  0x8000: 'Up', 0x8001: 'Left', 0x8002: 'Right', 0x8003: 'Down', 0x8004: 'Options', 0x8006: 'Power',
  0x8008: 'Back', 0x8009: 'ScrollUp', 0x800a: 'ScrollDown', 0x800b: 'Recent', 0x800c: 'Home',
  0x800d: 'Favorites', 0x800f: 'Search', 0x8010: 'Mail', 0x8011: 'Find', 0x8012: 'Info',
  0x8013: 'GoTo', 0x8014: 'Send', 0x8015: 'Save', 0x8016: 'Edit', 0x8018: 'View',
  0x8019: 'ChannelUp', 0x801a: 'ChannelDown',
};

// Table.2502: remote code -> key (EchoStar_ParseAndPost)
const REMOTE_KEYS = new Map([
  [0x1a, 0x8000], [0x1e, 0x8003], [0x1c, 0x8001], [0x18, 0x8002], [0x16, 0x8004], [0x10, 0x8005],
  [0x00, 0x8008], [0x12, 0x800b], [0x19, 0x8009], [0x1d, 0x800a], [0x14, 0x800c], [0x02, 0x8006],
  [0x0b, 0x8018], [0x20, 0x8019], [0x0f, 0x801a], [0x30, 0x801f], [0x31, 0x8020], [0x32, 0x8012],
  [0x35, 0x8021], [0x04, 0x31], [0x05, 0x32], [0x06, 0x33], [0x08, 0x34], [0x09, 0x35], [0x0a, 0x36],
  [0x0c, 0x37], [0x0d, 0x38], [0x0e, 0x39], [0x11, 0x30], [0x1b, 0x0d], [0x33, 0x8022], [0x34, 0x8023],
  [0x3b, 0x8017], [0x1f, 0x8024], [0x22, 0x8025], [0x23, 0x8026], [0x07, 0x8027], [0x24, 0x8028],
  [0x25, 0x8029], [0x21, 0x8030], [0x03, 0x8031], [0x26, 0x8032],
]);
export const REMOTE_CODES = new Map([...REMOTE_KEYS].map(([code, key]) => [key, code]));

// Table.2492: Sony command -> key (Sony_ParseAndPost). 0x8005 is Execute (DispatchInput takes it
// as it takes Return), Select on the bridge's screens. 0x2e / 0x2f (discrete power) left out.
const SONY_KEYS = new Map([
  [0x74, 0x8000], [0x75, 0x8003], [0x34, 0x8001], [0x33, 0x8002], [0x61, 0x8004], [0x65, 0x8005],
  [0x4c, 0x8008], [0x4b, 0x800b], [0x58, 0x8009], [0x59, 0x800a], [0x62, 0x800c], [0x15, 0x8006],
  [0x5c, 0x8018], [0x10, 0x8019], [0x11, 0x801a], [0x09, 0x30], [0x00, 0x31], [0x01, 0x32],
  [0x02, 0x33], [0x03, 0x34], [0x04, 0x35], [0x05, 0x36], [0x06, 0x37], [0x07, 0x38], [0x08, 0x39],
  [0x0b, 0x0d],
]);
export const SONY_CODES = new Map([...SONY_KEYS].map(([code, key]) => [key, code]));
// Table.2460: commands that don't repeat when held (SonyKeyCanRepeat)
const SONY_NO_REPEAT = new Set([0x61, 0x65, 0x4c, 0x4b, 0x62, 0x15, 0x5c, 0x0b]);

// sej2lc / sej2uc: keyboard scancode -> key, unshifted and shifted (0 = no key). 0x40xx are
// modifiers: 4001/4002 shift, 4003/4004 cmd, 4005/4006 ctrl, 4007 caps lock, 4008/4009 alt.
const SPECIAL = {
  0x03: 0x4004, 0x05: 0x8018, 0x09: 0x4007, 0x0b: 0x809b, 0x0c: 0x8097, 0x11: 0x8099, 0x13: 0x809a,
  0x14: 0x8098, 0x18: 0x4008, 0x19: 0x09, 0x1b: 0x8006, 0x1c: 0x4003, 0x28: 0x4009, 0x29: 0x1b,
  0x2b: 0x4005, 0x2d: 0x8013, 0x2f: 0x8014, 0x31: 0x4001, 0x32: 0x4002, 0x36: 0x801a, 0x37: 0x8019,
  0x38: 0x20, 0x39: 0x08, 0x3a: 0x0d, 0x3b: 0x809c, 0x3c: 0x800c, 0x3d: 0x800f, 0x48: 0x8001,
  0x4a: 0x8015, 0x4b: 0x8000, 0x4c: 0x8016, 0x4e: 0x8008, 0x50: 0x8003, 0x52: 0x8012, 0x53: 0x8018,
  0x54: 0x8004, 0x55: 0x8010, 0x56: 0x8009, 0x57: 0x801a, 0x58: 0x8002, 0x5b: 0x800a, 0x5c: 0x800b,
  0x5d: 0x8011, 0x5f: 0x801e, 0x61: 0x809d, 0x64: 0x800d, 0x70: 0x8017,
};
const CHARS = { // scancode: unshifted, shifted
  0x04: '`~', 0x0a: 'xX', 0x0d: '2@', 0x0e: 'sS', 0x0f: 'wW', 0x12: 'cC', 0x15: '3#', 0x16: 'dD',
  0x17: 'eE', 0x1a: 'zZ', 0x1d: '1!', 0x1e: 'aA', 0x1f: 'qQ', 0x20: 'bB', 0x21: 'tT', 0x22: 'vV',
  0x23: 'gG', 0x24: '5%', 0x25: '4$', 0x26: 'fF', 0x27: 'rR', 0x3e: '\\|', 0x62: '.>', 0x65: '9(',
  0x66: 'lL', 0x67: 'oO', 0x68: '/?', 0x69: '[{', 0x6b: '\'"', 0x6c: '-_', 0x6d: '0)', 0x6e: ';:',
  0x6f: 'pP', 0x71: ']}', 0x72: ',<', 0x74: '=+', 0x75: '8*', 0x76: 'kK', 0x77: 'iI', 0x78: 'nN',
  0x79: 'yY', 0x7a: 'mM', 0x7b: 'hH', 0x7c: '6^', 0x7d: '7&', 0x7e: 'jJ', 0x7f: 'uU',
};
const KB = { lc: new Uint16Array(128), uc: new Uint16Array(128) };
for (const [sc, k] of Object.entries(SPECIAL)) { KB.lc[sc] = k; KB.uc[sc] = k; }
for (const [sc, s] of Object.entries(CHARS)) { KB.lc[sc] = s.charCodeAt(0); KB.uc[sc] = s.charCodeAt(1); }

const MOD = { SHIFT: 0x01, CAPS: 0x02, CTRL: 0x04, CMD: 0x08, ALT: 0x40 };
const MOD_KEYS = { 0x4001: MOD.SHIFT, 0x4002: MOD.SHIFT, 0x4003: MOD.CMD, 0x4004: MOD.CMD, 0x4005: MOD.CTRL, 0x4006: MOD.CTRL, 0x4008: MOD.ALT, 0x4009: MOD.ALT };
const REPEATS = new Set([0x8000, 0x8001, 0x8002, 0x8003, 0x8009, 0x800a, 0x08]);

// key value -> what the UI gets: a one-character string, or a name
export const keyName = (k) => (k < 0x80 ? String.fromCharCode(k) : KEY_NAMES[k] ?? `0x${k.toString(16)}`);

// Feeds raw IR entries to the decoders; onKey(name, { source, code }) for each key press
export class IrKeys {
  // now() -> microseconds: the bridge's clock
  constructor(onKey, now = () => performance.now() * 1000) {
    this.now = now;
    this.onKey = onKey;
    this.mods = 0;
    this.capsLatch = false;
    this.remote = { key: -1, at: -Infinity, dups: 0, rate: 0 };
    this.lastKb = -1;
    this.sejin = new SejinDecoder((f) => this.keyboard(f));
    this.rc = new RemoteDecoder((f) => this.remoteFrame(f));
    this.sonyState = { cmd: -1, at: -Infinity, dups: 0, skip: false };
    this.sony = new SonyDecoder((f) => this.sonyFrame(f));
    this.overruns = 0;
  }

  // one DEV_IRIN_TRANS_DATA entry (InterpretIRSamples)
  entry(e) {
    if ((e & 0xf000) === 0xf000) { this.overruns++; return; }
    const level = (e >> 11) & 1, us = (e & 0x7ff) * IR_US_PER_TICK;
    this.rc.feed(level, us);
    this.sony.feed(level, us);
    this.sejin.feed(level, us);
  }

  // ParseIRKBData -> IRKBMake / IRKBBreak
  keyboard({ header, code }) {
    if ((header & 0x30) !== 0x10 || code & 0x80) return;
    if (header & 0x40) { // break
      const k = KB.lc[code];
      if (MOD_KEYS[k]) this.mods &= ~MOD_KEYS[k];
      if (k === 0x4007) this.capsLatch = false;
      if (code === this.lastKb) this.lastKb = -1;
      return;
    }
    if (code === this.lastKb) return; // held: the OS repeats from its own timer; we don't
    this.lastKb = code;
    let k = (this.mods & MOD.SHIFT ? KB.uc : KB.lc)[code];
    if (!k) return;
    if (MOD_KEYS[k]) { this.mods |= MOD_KEYS[k]; return; }
    if (k === 0x4007) { // caps lock: toggles once a press; shift+caps clears shift
      if (this.mods & MOD.SHIFT) this.mods &= ~MOD.SHIFT;
      else if (!this.capsLatch) { this.mods ^= MOD.CAPS; this.capsLatch = true; }
      return;
    }
    if (this.mods & MOD.CAPS) {
      if (k >= 0x61 && k <= 0x7a) k -= 0x20;
      else if (k >= 0x41 && k <= 0x5a) k += 0x20;
    }
    if (this.mods & MOD.CTRL && ((k >= 0x61 && k <= 0x7a) || (k >= 0x41 && k <= 0x5a))) k &= 0x1f;
    this.onKey(keyName(k), { source: 'keyboard', code });
  }

  // HandleEchoStarIR: a new code, or the same one after a pause, posts; within 117 ms it is a hold
  remoteFrame({ key: code }) {
    const r = this.remote, k = REMOTE_KEYS.get(code);
    const t = this.now();
    const fresh = code !== r.key || t - r.at > 7e6 / 60;
    r.key = code;
    r.at = t;
    if (k === undefined) return;
    if (fresh) { r.dups = 0; r.rate = 0; this.onKey(keyName(k), { source: 'remote', code }); return; }
    if (!REPEATS.has(k)) return;
    if (r.dups < 9) { r.dups++; return; }
    if (r.rate < 3) { r.rate++; return; }
    r.rate = 0;
    this.onKey(keyName(k), { source: 'remote', code });
  }

  // HandleSonyIR: a new command, or the same one after a pause (7 ticks), posts; a held one
  // that can repeat posts again after 5 more, then every other
  sonyFrame({ cmd }) {
    const r = this.sonyState, t = this.now();
    let k = SONY_KEYS.get(cmd);
    const fresh = cmd !== r.cmd || t - r.at > 7e6 / 60;
    r.cmd = cmd;
    r.at = t;
    if (k === undefined) return;
    if (k === 0x8005) k = 0x0d;
    if (fresh) { r.dups = 0; r.skip = false; this.onKey(keyName(k), { source: 'sony', code: cmd }); return; }
    if (SONY_NO_REPEAT.has(cmd)) return;
    if (r.dups < 5) { r.dups++; return; }
    if (!r.skip) { r.skip = true; return; }
    r.skip = false;
    this.onKey(keyName(k), { source: 'sony', code: cmd });
  }
}
