// The loader as a "tier-3 diagnostics" image (WEBTV_LPT_BRIDGE.md §10.7): the way in on a box
// whose boot ROM has no debug monitor (production ROMs, e.g. 2046: test 18 answers "Debugger not
// implemented on non-debug Rom"). Their diagnostics' test 19, "Continue To Tier3 Diags", reads
// the disk's tier-3 area (TIER3_LBA, 8192 sectors) into 0x80400000, checks it as it checks an OS
// (code checksum; ROM filesystem, or 'NoFS') plus flags bit 3 in the header, and jumps to it.
// The image: an OS-style header, a stub that copies the loader down to LOADER_BASE (an OS is
// read to 0x80400000 and up later) and jumps to it, then the loader. About 6 KB; written once
// to the disk (tools/lptdisk.mjs --tier3). The OS itself is never touched.

import { parse, prepare, unitSize, unitLabels, assemble } from '../lptmodem/asm.js';
import { buildLoader, LOADER_BASE } from './loader.js';

export const TIER3_LBA = 34312;
export const TIER3_SECTORS = 8192;
export const TIER3_BASE = 0x80400000;
const HDR = 0x40;
const FLAG_TIER3 = 8;

export function buildTier3(opts) { return buildTier3Parts(opts).img; }

// -> { img, sources, placed }: the image, and the stub's source and placement for listings
export function buildTier3Parts({ loader = buildLoader() } = {}) {
  if (loader.base !== LOADER_BASE) throw new Error('the loader must be built for LOADER_BASE');
  const hexw = (v) => `0x${(v >>> 0).toString(16)}`;
  const stubSource = `
# Test 19 has read the tier-3 area to its base and jumped here, past the OS-style header. The
# loader that follows is copied down to LOADER_BASE (uncached), out of the way of the OS the
# bridge reads to 0x80400000 and up, and started there.
.func t3_stub
  la   t0, T3_PAYLOAD              # from: the loader's words, right after this stub
  li   t1, ${hexw(LOADER_BASE)}         # to: LOADER_BASE (kseg1)
  li   t2, ${loader.size / 4}                 # the loader's length in words
t3_copy:
  lw   t3, 0(t0)
  sw   t3, 0(t1)
  addiu t0, t0, 4
  addiu t2, t2, -1
  bnez t2, t3_copy
  addiu t1, t1, 4                  # (delay slot)
  li   t0, ${hexw(LOADER_BASE)}         # start it
  jr   t0
  nop
T3_PAYLOAD:                        # the loader image follows
.endfunc
`;
  const prog = parse(stubSource, 'tier3');
  const labels = new Map(), lookup = (n) => labels.get(n);
  for (const u of prog.units) prepare(u, lookup);
  const at = TIER3_BASE + HDR;
  for (const [k, v] of unitLabels(prog.units[0], at)) labels.set(k, v);
  const stub = assemble(prog.units[0], at, lookup);
  const img = new Uint8Array((HDR + stub.length + loader.size + 511) & ~511);
  const put = (o, v) => { img[o] = v >>> 24; img[o + 1] = v >>> 16; img[o + 2] = v >>> 8; img[o + 3] = v; };
  img.set(stub, HDR);
  img.set(loader.bytes, HDR + stub.length);
  put(0x00, 0x1000000f);           // b 0x40 (the boot ROM jumps to the base)
  put(0x0c, img.length / 4);       // build size, words
  put(0x10, img.length / 4);       // checksummed words: all of it
  put(0x24, 0x4e6f4653);           // 'NoFS': no ROM filesystem
  put(0x30, TIER3_BASE);
  put(0x34, FLAG_TIER3);
  let sum = 0;
  for (let o = 0; o < img.length; o += 4) if (o !== 8) sum = (sum + ((img[o] << 24) | (img[o + 1] << 16) | (img[o + 2] << 8) | img[o + 3])) >>> 0;
  put(0x08, sum);
  return { img, sources: [{ file: 'tier3', text: stubSource }], placed: [{ u: prog.units[0], at, bytes: stub }] };
}
