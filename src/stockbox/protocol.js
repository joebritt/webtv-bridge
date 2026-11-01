// Bridge <-> stock-box loader protocol (src/stockbox/loader.js), carried on PARMOD's modem
// channel. Numbers are big-endian. Colours are 4:2:2 words, Y Cb Y Cr, as the framebuffer
// holds them (yuyv() converts from RGB).
//
// Bridge -> loader, commands:
//   HELLO                                      -> HELLO reply
//   FILL  x:2 y:2 w:2 h:2 colour:4             fill a rectangle (x, w rounded to even)
//   TEXT  x:2 y:2 scale:1 fg:4 bg:4 n:1 chars  text; cells are 12*scale x 16*scale pixels
//   SYNC  n:1                                  -> SYNC reply n, once everything before it is drawn
//   RESET                                      reset the box (the ROM's own write: 7 to BUS_RESETCAUSE)
//   READ  addr:4 width:1 count:2               -> DATA: count items of width bytes (1, 2 or 4)
//   WRITE addr:4 width:1 count:2 data          -> DONE
//   CALL  addr:4 a0:4 a1:4 a2:4 a3:4           -> RET v0, after calling addr (interrupts off,
//                                                 on the loader's stack)
// READ and WRITE use loads and stores of that width (so SOLO registers see the access they
// expect) and answer FAULT instead when the range leaves RAM (kseg0 or kseg1), the boot ROM or
// the SOLO registers, or the address isn't aligned to the width. The loader runs uncached and
// has no cache instruction: write code through kseg1 (0xa...) and call it there.
//
// Loader -> bridge, messages (a type byte, then a fixed or counted body):
//   0x81 HELLO  'L' 'D' 'R' version
//   0x84 SYNC   n
//   0x90 IR     n:1, then n entries:2       raw IR receiver runs, sent as they arrive
//   0x92 DATA   count:2, then the items
//   0x93 DONE
//   0x94 RET    v0:4
//   0x9F FAULT  why:1 (1 out of range, 2 unaligned, 3 bad width)
//   0xEE ERR    byte                        a command the loader doesn't know
//
// Stage 0 (loader.js buildStage0), typed in before all this, takes the loader over the same
// link: length:4 (bytes), the words, then their 32-bit sum; it answers 0x8A and jumps to the
// loader, or 0x8B on a bad sum and waits for the image again.
//
// An IR entry is what the SOLO IR receiver's FIFO (DEV_IRIN_TRANS_DATA) holds, the same
// samples the OS's InterpretIRSamples feeds its decoders: bits 15-12 the FIFO count (0xf =
// overrun), bit 11 the level, bits 10-0 the run's length in 15 us ticks. Decoding (remotes,
// the IR keyboard) happens on the bridge (irdecode.js), so the loader stays small.

export const LDR_VERSION = 5;   // 4 added TEXT2 (the boot ROM's own fonts) and VFILT (the OS's flicker filter); 5 TARGET and COPY (a back buffer)
export const CMD = { HELLO: 0x01, FILL: 0x02, TEXT: 0x03, SYNC: 0x04, RESET: 0x05, READ: 0x06, WRITE: 0x07, CALL: 0x08, TEXT2: 0x09, VFILT: 0x0a, TARGET: 0x0b, COPY: 0x0c };
export const MSG = { HELLO: 0x81, SYNC: 0x84, IR: 0x90, ERR: 0xee, LOADED: 0x8a, BADSUM: 0x8b, DATA: 0x92, DONE: 0x93, RET: 0x94, FAULT: 0x9f };
export const FAULT = { 1: 'out of range', 2: 'unaligned', 3: 'bad width' };
// what READ, WRITE and CALL may touch: [start, end) in the CPU's address map
export const RANGES = [
  [0x80000000, 0x80800000], [0xa0000000, 0xa0800000],    // RAM, cached and uncached
  [0x9fc00000, 0x9fe00000], [0xbfc00000, 0xbfe00000],    // boot ROM
  [0xa4000000, 0xa4010000],                              // SOLO registers
];
export const IR_US_PER_TICK = 15;      // the sample interval the loader sets, as the OS does
export const SCREEN = { W: 560, H: 420 };   // the loader's framebuffer, as the boot ROM's video tests use it
export const CELL = { W: 12, H: 16 };       // text cell at scale 1

// RGB (0-255) -> a Y Cb Y Cr word, ITU-R BT.601 studio range
export function yuyv(r, g, b) {
  const y = Math.round(16 + (65.481 * r + 128.553 * g + 24.966 * b) / 255);
  const cb = Math.round(128 + (-37.797 * r - 74.203 * g + 112 * b) / 255);
  const cr = Math.round(128 + (112 * r - 93.786 * g - 18.214 * b) / 255);
  return ((y << 24) | (cb << 16) | (y << 8) | cr) >>> 0;
}

const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

// command encoders -> arrays of bytes
export const enc = {
  hello: () => [CMD.HELLO],
  fill: (x, y, w, h, colour) => [CMD.FILL, ...u16(x), ...u16(y), ...u16(w), ...u16(h), ...u32(colour)],
  // text in a boot ROM font strike (its address in the box, strike.js): x is the pen, y the baseline
  text2: (strike, x, y, fg, s) => {
    const chars = Array.from(s.slice(0, 255), (c) => c.charCodeAt(0) & 0xff);
    return [CMD.TEXT2, ...u32(strike), ...u16(x), ...u16(y), ...u32(fg), chars.length, ...chars];
  },
  // the OS's vertical flicker filter over a rectangle (FilterBlitYUYVtoYUYV's arithmetic)
  vfilt: (x, y, w, h) => [CMD.VFILT, ...u16(x), ...u16(y), ...u16(w), ...u16(h)],
  text: (x, y, scale, fg, bg, s) => {
    const chars = [...s].slice(0, 255).map((c) => c.charCodeAt(0) & 0xff);
    return [CMD.TEXT, ...u16(x), ...u16(y), scale, ...u32(fg), ...u32(bg), chars.length, ...chars];
  },
  sync: (n) => [CMD.SYNC, n & 0xff],
  reset: () => [CMD.RESET],
  read: (addr, width, count) => [CMD.READ, ...u32(addr), width, ...u16(count)],
  write: (addr, width, values) => [CMD.WRITE, ...u32(addr), width, ...u16(values.length),
    ...values.flatMap((v) => (width === 4 ? u32(v) : width === 2 ? u16(v) : [v & 0xff]))],
  call: (addr, args = []) => [CMD.CALL, ...u32(addr), ...[0, 1, 2, 3].flatMap((i) => u32(args[i] ?? 0))],
};

// the loader image for stage 0: length, the words, their sum
export function stage0Image(bytes) {
  const out = [...u32(bytes.length)];
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const w = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    sum = (sum + w) >>> 0;
    out.push(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
  }
  return [...out, ...u32(sum)];
}

// Splits the loader's byte stream into messages: feed(byte) calls onMessage(msg) with
// { type: 'hello', name, version } | { type: 'sync', n } | { type: 'ir', entries } |
// { type: 'err', byte } | { type: 'loaded' } | { type: 'badsum' } | { type: 'done' } |
// { type: 'ret', v0 } | { type: 'fault', why } | { type: 'data', bytes } (DATA's items, as bytes:
// the reader knows the width it asked for) | { type: 'junk', byte }
export class MessageParser {
  constructor(onMessage) { this.onMessage = onMessage; this.buf = []; }

  feed(b) {
    const m = this.buf;
    m.push(b);
    const t = m[0];
    if (t === MSG.LOADED) this.emit({ type: 'loaded' });
    else if (t === MSG.DONE) this.emit({ type: 'done' });
    else if (t === MSG.RET && m.length === 5) this.emit({ type: 'ret', v0: ((m[1] << 24) | (m[2] << 16) | (m[3] << 8) | m[4]) >>> 0 });
    else if (t === MSG.FAULT && m.length === 2) this.emit({ type: 'fault', why: m[1] });
    else if (t === MSG.DATA && m.length >= 3) {
      // DATA's length depends on the width asked for; the reader says how many bytes to expect
      if (m.length === 3) this.need = ((m[1] << 8) | m[2]) * (this.width || 1);
      if (m.length === 3 + this.need) this.emit({ type: 'data', bytes: Uint8Array.from(m.slice(3)) });
    }
    else if (t === MSG.BADSUM) this.emit({ type: 'badsum' });
    else if (t === MSG.HELLO && m.length === 5) this.emit({ type: 'hello', name: String.fromCharCode(m[1], m[2], m[3]), version: m[4] });
    else if (t === MSG.SYNC && m.length === 2) this.emit({ type: 'sync', n: m[1] });
    else if (t === MSG.ERR && m.length === 2) this.emit({ type: 'err', byte: m[1] });
    else if (t === MSG.IR && m.length >= 2 && m.length === 2 + 2 * m[1]) {
      const entries = [];
      for (let i = 2; i < m.length; i += 2) entries.push((m[i] << 8) | m[i + 1]);
      this.emit({ type: 'ir', entries });
    } else if (![MSG.HELLO, MSG.SYNC, MSG.ERR, MSG.IR, MSG.RET, MSG.FAULT, MSG.DATA].includes(t)) this.emit({ type: 'junk', byte: t });
  }

  emit(msg) { this.buf = []; this.onMessage(msg); }
}
