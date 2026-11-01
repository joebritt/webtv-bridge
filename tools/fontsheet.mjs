#!/usr/bin/env node
// A test sheet of the boot ROM's fonts, read in place from a boot ROM image the way the Bridge's
// loader will read them in the box (src/stockbox/strike.js): every face and size, drawn with
// 4-bit coverage onto the Bridge's navy, as the TV screens would show them (560x420, the
// loader's screen).
//
//   node tools/fontsheet.mjs [--rom FILE] [--out FILE.png]
import { readFileSync } from 'node:fs';
import { readFile } from '../src/machine/romfs.js';
import { parseStrike } from '../src/stockbox/strike.js';
import { writePng } from './png.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const rom = new Uint8Array(readFileSync(opt('rom', 'data/flipped_merged_boot.bin')));
const W = 560, H = 760;
const rgb = (r, g, b) => r | (g << 8) | (b << 16);
const NAVY = [26, 36, 92], WHITE = [235, 235, 235], DIM = [150, 160, 190];
const fb = new Uint32Array(W * H).fill(rgb(...NAVY));
const strikes = new Map();
const strike = (face, size) => {
  const k = `${face}_${size}`;
  if (!strikes.has(k)) {
    const f = readFile(rom, `Fonts/${k}`);
    if (!f) throw new Error(`no Fonts/${k} in this ROM`);
    strikes.set(k, parseStrike(f));
  }
  return strikes.get(k);
};
// text at (x, baseline y): coverage blended from the background to the colour
function text(face, size, x, y, s, col = WHITE) {
  const st = strike(face, size);
  let pen = x * 16;
  for (const ch of s) {
    const g = st.glyph(ch.charCodeAt(0));
    if (!g) continue;
    const gx = Math.round(pen / 16) - g.left, gy = y - g.top;   // PaintText: x -= left, y -= top
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
      const a = g.px[j * g.w + i] / 15, px = gx + i, py = gy + j;
      if (!a || px < 0 || py < 0 || px >= W || py >= H) continue;
      const o = py * W + px, bg = [fb[o] & 255, (fb[o] >> 8) & 255, (fb[o] >> 16) & 255];
      fb[o] = rgb(...bg.map((b, k) => Math.round(b + (col[k] - b) * a)));
    }
    pen += g.advance;
  }
  return Math.round(pen / 16);
}

let y = 40;
text('Bold', 22, 24, y, 'The WebTV Modem / Printer Bridge');
y += 34;
for (const face of ['Roman', 'Bold', 'Black', 'Italic']) {
  for (const size of [12, 14, 16, 18, 20, 22]) {
    const end = text(face, size, 24, y, `${face} ${size}: Choose your network: NETGEAR42`);
    y += Math.max(size + 8, strike(face, size).ascent + strike(face, size).descent + 6);
    if (end > W - 8) console.log(`${face} ${size} runs ${end - W} px over`);
  }
  y += 6;
}
text('Roman', 16, 24, y, 'Starting in 10 s. Any key stops it.  0123456789 @#&!?', DIM);
const out = opt('out', 'out/fontsheet.png');
writePng(out, fb, W, H);
console.log(`${strikes.size} strikes read from the boot ROM's Fonts/ -> ${out}`);
