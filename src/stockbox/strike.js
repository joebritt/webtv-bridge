// The WebTV OS's font strikes, as the boot ROM keeps them (ROM filesystem, Fonts/<Face>_<size>:
// Roman, Bold, Black, Italic at 12-22; every LC2 boot ROM seen has the same 24). The format is the
// OS's own (build 16406: FontToStrike, PaintText, DecompressGlyph); this is the reference the
// Bridge's loader follows to draw with them in place in the box.
//
// Strike, big-endian:
//   0x00 u16 version/flags (0x000d in the boot ROM strikes: bit 0 advances in 1/16 px, bit 3 the
//        table layout below)
//   0x02 name, NUL-padded ("Roman_16")
//   0x26 u16 point size; 0x2c depth (4: 4-bit coverage); 0x2d first char (0x20); 0x2e last (0xff)
//   0x34 u16 ascent, 0x36 u16 descent, 0x38 u16 leading
//   B = 0x3c, the tables:
//   B+0x0e0  224 character entries, one per code from 0x20: [metrics index, glyph index (255 =
//            none), 0xff, 0xff]
//   B+0x460  the same for a second variant (another face) - not needed here
//   B+0x7e0  u16 metrics count; B+0x7e2 u16 offset of the variant's glyph table; B+0x7e4 glyph count
//   B+0x7e8  metrics: [i16 advance (1/16 px), i8 left, i8 top (above the baseline)]; a glyph is
//            drawn at (pen - left, baseline - top) (PaintText subtracts both)
//   then     glyphs: [u16 bitmap offset, 0x80 | width, height]
//   then     the bitmaps, each its own run of nibbles (DecompressGlyph): high nibble first; a
//            nibble with bit 3 set is a run of (n & 3) + 2 pixels, all 15 (bit 2) or all 0;
//            otherwise one pixel of 3-bit coverage, widened to 4 bits as (n << 1) | (n >> 2).
//            Rows follow each other with no padding.

const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const s8 = (v) => (v << 24) >> 24;
const s16 = (v) => (v << 16) >> 16;

export function parseStrike(d) {
  const B = 0x3c;
  let name = '';
  for (let i = 2; i < 0x24 && d[i]; i++) name += String.fromCharCode(d[i]);
  const s = {
    name, version: be16(d, 0), size: be16(d, 0x26), depth: d[0x2c], first: d[0x2d], last: d[0x2e],
    ascent: be16(d, 0x34), descent: be16(d, 0x36), leading: be16(d, 0x38),
  };
  if (s.depth !== 4 || !(s.version & 8)) throw new Error(`${name}: not a strike this reader knows (version ${s.version}, depth ${s.depth})`);
  const metricsCount = be16(d, B + 0x7e0), glyphCount = d[B + 0x7e4];
  const M = B + 0x7e8, G = M + metricsCount * 4, BITS = G + glyphCount * 4;
  const cache = new Map();
  // -> { advance (1/16 px), left, top, w, h, px (Uint8Array w*h, coverage 0-15) } or null
  s.glyph = (code) => {
    if (cache.has(code)) return cache.get(code);
    let g = null;
    if (code >= 0x20 && code <= 0xff) {
      const e = B + 0xe0 + (code - 0x20) * 4, mi = d[e], gi = d[e + 1];
      if (gi !== 0xff && gi < glyphCount && mi < metricsCount) {
        const m = M + mi * 4, q = G + gi * 4;
        g = { advance: s16(be16(d, m)), left: s8(d[m + 2]), top: s8(d[m + 3]), w: d[q + 2] & 0x7f, h: d[q + 3] };
        g.px = decompress(d, BITS + be16(d, q), g.w, g.h);
      }
    }
    cache.set(code, g);
    return g;
  };
  // the width of a string in pixels (advances are in 1/16 px)
  s.measure = (text) => { let pen = 0; for (const ch of text) { const g = s.glyph(ch.charCodeAt(0)); if (g) pen += g.advance; } return Math.round(pen / 16); };
  return s;
}

// DecompressGlyph: -> w*h coverage values 0-15
export function decompress(d, p, w, h) {
  const out = new Uint8Array(w * h);
  let high = true, run = 0, rv = 0;
  for (let i = 0; i < w * h; i++) {
    if (run) { run--; out[i] = rv; continue; }
    const n = high ? d[p] >> 4 : d[p++] & 15;
    high = !high;
    if (n & 8) { run = (n & 3) + 1; rv = n & 4 ? 15 : 0; out[i] = rv; }
    else out[i] = (n << 1) | (n >> 2);
  }
  return out;
}
