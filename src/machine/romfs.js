// The ROM filesystem (file://ROM/) of a WebTV OS build image (_approm.o): read, extract and
// replace files. Node only (the codecs are minisrv's CommonJS ones). CLI: tools/romfs.mjs.
//
// Layout (LC2 builds): the ROMFS sits at the top of the build (build size from the header). The
// image ends with an 8-byte trailer [length in words][word sum] covering the ROMFS from its
// start up to the trailer. File data comes first; the directory entries follow, with the root
// ("ROM") last. Below the ROMFS start, back to the end of the checksummed code, is filler
// ("beoj...", "joeb..." in 1998-99 builds), i.e. free space. Each entry is 0x38 bytes:
//   0x00 next sibling  0x04 parent  0x08 first child  0x0c data (RAM address, 0 for a directory)
//   0x10 length in the low 28 bits; 0x80000000 = compressed, LZSS if 0x10000000 is also set,
//        else LZPF  0x14 type?  0x18 byte sum of the stored data  0x1c name, NUL-terminated
// Compressed data is [u32 expanded length][LZPF or LZSS stream]. minisrv's codecs expand them all,
// and its LZPF compressor reproduces the ROM's LZPF files byte for byte.
//
// put stores the new file compressed if the old one was, in place if it fits, otherwise in the
// free space below the ROMFS (moving the ROMFS start down), and updates the entry and trailer.
import { createRequire } from 'node:module';
import { osImageInfo } from './osinstall.js';

const require = createRequire(import.meta.url);
const LZPF = require('../../services/minisrv/includes/classes/LZPF.js');
const LZSS = require('../../services/minisrv/includes/classes/LZSS.js');

export const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const put32 = (b, o, v) => { b[o] = v >>> 24; b[o + 1] = v >>> 16; b[o + 2] = v >>> 8; b[o + 3] = v; };
const COMPRESSED = 0x80000000, LZSS_FLAG = 0x10000000, FLAGS = 0xf0000000;
export const storedLen = (f) => f.len & ~FLAGS;
const codec = (f) => (f.len & COMPRESSED ? (f.len & LZSS_FLAG ? new LZSS() : new LZPF()) : null);
export const method = (f) => (f.len & COMPRESSED ? (f.len & LZSS_FLAG ? 'lzss' : 'lzpf') : '    ');
const FILLER = 'beoj', FILLER_OLD = 'joeb';

export function readRomfs(img) {
  const info = osImageInfo(img);
  const end = info.size;
  const words = be32(img, end - 8);
  const start = end - 8 - words * 4;
  if (!words || start < info.codeSize) throw new Error('no ROMFS trailer at the end of the build');
  const off = (addr) => addr - info.base;
  const rootOff = end - 0x40;
  const entry = (o) => {
    let name = '';
    for (let i = o + 0x1c; img[i] && name.length < 0x1c; i++) name += String.fromCharCode(img[i]);
    return { o, next: be32(img, o), parent: be32(img, o + 4), child: be32(img, o + 8), data: be32(img, o + 12),
      len: be32(img, o + 16), type: be32(img, o + 20), sum: be32(img, o + 24), name };
  };
  const root = entry(rootOff);
  if (root.name !== 'ROM') throw new Error(`no ROMFS root at ${rootOff.toString(16)}`);
  const files = [];
  const walk = (addr, dir, depth) => {
    for (let a = addr; a && depth < 16;) {
      const o = off(a);
      if (o < start || o >= end) break;
      const e = entry(o);
      e.path = dir ? `${dir}/${e.name}` : e.name;
      if (e.data) files.push(e); else walk(e.child, e.path, depth + 1);
      a = e.next;
    }
  };
  walk(root.child, '', 0);
  return { info, start, end, files, off };
}

export const byteSum = (b) => { let s = 0; for (const c of b) s = (s + c) >>> 0; return s; };
export const wordSum = (b, from, to) => { let s = 0; for (let o = from; o < to; o += 4) s = (s + be32(b, o)) >>> 0; return s; };

export function getFile(img, fs, f) {
  const raw = img.subarray(fs.off(f.data), fs.off(f.data) + storedLen(f));
  if (!(f.len & COMPRESSED)) return Uint8Array.from(raw);
  const want = be32(raw, 0);
  const out = codec(f).expand(Buffer.from(raw.subarray(4)), want);
  if (out.length !== want) throw new Error(`${f.path}: expanded to ${out.length} bytes, expected ${want}`);
  return new Uint8Array(out);
}

export const findFile = (fs, path) => fs.files.find((x) => x.path.toLowerCase() === path.toLowerCase());

// Read a file by path (null if there is no such file).
export function readFile(img, path) {
  const fs = readRomfs(img);
  const f = findFile(fs, path);
  return f ? getFile(img, fs, f) : null;
}

// -> { image (a copy), note, before, after }
export function putFile(imgIn, path, content) {
  const img = Uint8Array.from(imgIn);
  const fs = readRomfs(img);
  const f = findFile(fs, path);
  if (!f) throw new Error(`no ${path} in the ROMFS`);
  let stored = content;
  if (f.len & COMPRESSED) {
    const c = codec(f).compress(Buffer.from(content));
    stored = new Uint8Array(4 + c.length);
    put32(stored, 0, content.length);
    stored.set(c, 4);
  }
  const oldOff = fs.off(f.data), oldLen = storedLen(f);
  let where, start = fs.start, note;
  if (stored.length <= oldLen) {
    where = oldOff;
    note = 'in place';
  } else {
    // free space: filler words just below the ROMFS start
    const need = (stored.length + 3) & ~3;
    where = fs.start - need;
    if (where < fs.info.codeSize) throw new Error('not enough free space below the ROMFS');
    // the filler is "beoj" (older builds: "joeb") repeated from the end of the code
    const c = fs.info.codeSize, pat = String.fromCharCode(...img.subarray(c, c + 4));
    if (!(FILLER + FILLER).includes(pat) && !(FILLER_OLD + FILLER_OLD).includes(pat)) throw new Error('no filler after the code');
    for (let o = where; o < fs.start; o++) if (img[o] !== img[c + ((o - c) & 3)]) throw new Error(`free space at ${o.toString(16)} is not filler`);
    start = where;
    note = `moved to free space at ${(fs.info.base + where).toString(16)}`;
  }
  img.set(stored, where);
  put32(img, f.o + 12, fs.info.base + where);
  put32(img, f.o + 16, (stored.length | (f.len & FLAGS)) >>> 0);
  put32(img, f.o + 24, byteSum(stored));
  // trailer
  put32(img, fs.end - 8, (fs.end - 8 - start) / 4);
  put32(img, fs.end - 4, wordSum(img, start, fs.end - 8));
  return { image: img, note, before: oldLen, after: stored.length };
}
