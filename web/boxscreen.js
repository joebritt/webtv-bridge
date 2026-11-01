// A screenshot of a real box, from its memory (the Bridge's /mem): what the SOLO puts on the
// TV, as an RGBA picture, made the way the emulator makes it (src/machine/solo_cels.js).
//
// The SOLO shows one of two things (potUnit control bit 3):
//   - the vidUnit's framebuffer: Y Cb Y Cr words from VID_NSTART, the potUnit's width and height
//     (the Bridge's own screens draw this way). It is read as it is: the raw YUV is exact.
//   - the gfxUnit's composite: a y-map of bands, each a list of cels drawing textures from RAM
//     (the OS draws this way). Nothing in RAM holds the picture, so it is composited here with
//     the emulator's compositor. The RAM it needs is found by running the compositor over what
//     has been read so far and noting every word it touches that hasn't been read; those are
//     read and it runs again, until it touches nothing new (the y-map, then the cels, then
//     their textures and codebooks). The raw YUV is converted back from the picture.
//
// readMem(addr, len) -> Promise<Uint8Array> (big-endian words); ram(phys) gives the address to
// ask for a physical RAM address (kseg1 through the loader, kseg0 through the running OS).
// The page (pico/web/page.js) and tools/bridgesim.mjs both use grabScreen; tools/webgen.mjs
// inlines this file and solo_cels.js into the page.
import { drawCels, put422, pack, SCREEN_W, SCREEN_H, Y_BLACK, Y_RANGE, UV_OFFSET } from '../src/machine/solo_cels.js';

const POT_FCNTL_USEGFX = 1 << 3, POT_FCNTL_EN = 1 << 0, GFX_FCNTL_EN = 1 << 7, VID_DMACNTL_DMAEN = 1 << 2;
const POT_HSTART_OFFSET = 0x77, POT_VSTART_OFFSET = 0x23;
const RAM_BYTES = 8 << 20, RAM_MASK = RAM_BYTES - 1;
const BLOCK = 256;                    // bytes read at a time for the compositor
const SOLO = 0xa4000000;

const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

// the video registers, in runs of plain registers (reading them changes nothing)
async function readRegs(readMem) {
  const runs = [[0x300c, 1], [0x3014, 1], [0x9080, 6], [0x6004, 1], [0x601c, 3], [0x6044, 3]];
  const r = {};
  for (const [off, n] of runs) {
    const b = await readMem(SOLO + off, n * 4);
    for (let i = 0; i < n; i++) r[off + i * 4] = be32(b, i * 4);
  }
  return {
    nstart: r[0x300c], dmacntl: r[0x3014],
    vstart: r[0x9080], vsize: r[0x9084], blankColor: r[0x9088], hstart: r[0x908c], hsize: r[0x9090], potCntl: r[0x9094],
    gfxCntl: r[0x6004], celsBaseMaster: r[0x601c], ymapBaseMaster: r[0x6020], initColor: r[0x6024],
    hcounterInit: r[0x6044], blankLines: r[0x6048], activeLines: r[0x604c],
  };
}

// the window on the 640 x 480 picture, as SoloVideo.validate() works it out
function viewWindow(R) {
  let hsize = Math.min(Math.max(R.hsize & 0x3ff, 2), SCREEN_W);
  let vsize = Math.min(Math.max(R.vsize & 0x3ff, 2), SCREEN_H);
  if (R.hcounterInit) hsize = Math.min(hsize, 2 * R.hcounterInit);
  if (R.activeLines) vsize = Math.min(vsize, Math.max(2, 2 * R.activeLines - R.blankLines - 2));
  let hstart = Math.max((R.hstart | 0) - POT_HSTART_OFFSET, 2);
  let vstart = Math.max((R.vstart | 0) - POT_VSTART_OFFSET, 2);
  if (hstart + hsize > SCREEN_W) hstart = SCREEN_W - hsize;
  if (vstart + vsize > SCREEN_H) vstart = SCREEN_H - vsize;
  return { hstart, hsize, vstart, vsize };
}

function blankPixel(c) {
  const y = (((((c >> 16) & 0xff) - Y_BLACK) << 8) + UV_OFFSET) / Y_RANGE | 0;
  const cb = ((c >> 8) & 0xff) - UV_OFFSET, cr = (c & 0xff) - UV_OFFSET;
  const r = ((0x166 * cr) + UV_OFFSET) >> 8, b = ((0x1c7 * cb) + UV_OFFSET) >> 8, g = ((0x32 * b) + (0x83 * r) + UV_OFFSET) >> 8;
  return pack(y + r, y - g, y + b);
}

// RGBA (0xAABBGGRR) -> Y Cb Y Cr, ITU-R BT.601 studio range, two pixels a word
function toYuyv(px, w, h) {
  const out = new Uint8Array(w * h * 2);
  for (let i = 0, o = 0; i + 1 < w * h; i += 2, o += 4) {
    const a = px[i], b = px[i + 1];
    const yuv = (p) => {
      const r = p & 0xff, g = (p >>> 8) & 0xff, bl = (p >>> 16) & 0xff;
      return [16 + (65.738 * r + 129.057 * g + 25.064 * bl) / 256, 128 + (-37.945 * r - 74.494 * g + 112.439 * bl) / 256,
        128 + (112.439 * r - 94.154 * g - 18.285 * bl) / 256];
    };
    const [y0, cb0, cr0] = yuv(a), [y1, cb1, cr1] = yuv(b);
    const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
    out[o] = c(y0); out[o + 1] = c((cb0 + cb1) / 2); out[o + 2] = c(y1); out[o + 3] = c((cr0 + cr1) / 2);
  }
  return out;
}

// -> { width, height, rgba (Uint32Array, 0xAABBGGRR), yuyv (Uint8Array), mode: 'framebuffer' |
// 'compositor', address, regs, bytesRead }
export async function grabScreen(readMem, ram, progress = () => {}) {
  let bytesRead = 0;
  const read = async (a, n) => { const b = await readMem(a, n); bytesRead += b.length; return b; };
  const R = await readRegs(read);
  if (!(R.potCntl & POT_FCNTL_USEGFX)) {
    // the framebuffer, read as it is
    const w = (R.hsize & 0x3ff) & ~1, h = R.vsize & 0x3ff;
    if (w < 2 || h < 2 || w > 800 || h > 600) throw new Error("the box's video isn't set up");
    const n = w * 2 * h;
    progress(0, n);
    const yuyv = await read(ram(R.nstart & RAM_MASK), n);
    const rgba = new Uint32Array(w * h);
    for (let i = 0, p = 0; i + 3 < yuyv.length; i += 4, p += 2) put422(rgba, p, be32(yuyv, i), 0xff, null, false);
    return { width: w, height: h, rgba, yuyv, mode: 'framebuffer', address: R.nstart, regs: R, bytesRead };
  }
  // the compositor
  const D = viewWindow(R);
  const words = new Uint32Array(RAM_BYTES / 4), have = new Uint8Array(RAM_BYTES / BLOCK);
  const enabled = (R.potCntl & POT_FCNTL_EN) && (R.gfxCntl & GFX_FCNTL_EN) && (R.ymapBaseMaster >>> 0) !== 0x80000000;
  const blank = blankPixel(R.blankColor);
  const render = (ramView) => {
    const fb = new Uint32Array(SCREEN_W * SCREEN_H).fill(blank);
    if (!enabled) return fb;
    for (let y = D.vstart; y < D.vstart + D.vsize; y++) fb.fill(0xff000000, y * SCREEN_W + D.hstart, y * SCREEN_W + D.hstart + D.hsize);
    const G = { ymapBaseMaster: R.ymapBaseMaster, celsBaseMaster: R.celsBaseMaster, ymapBase: R.ymapBaseMaster, celsBase: R.celsBaseMaster, initColor: R.initColor };
    drawCels(ramView, RAM_MASK, G, D, fb);
    return fb;
  };
  for (let pass = 0; pass < 12; pass++) {
    // run it, noting the blocks it touched that haven't been read
    const need = new Set();
    const spy = new Proxy(words, {
      get(t, k) {
        if (typeof k === 'string') {
          const i = +k;
          if (i >= 0 && i < t.length && Number.isInteger(i)) { const blk = (i * 4) / BLOCK | 0; if (!have[blk]) need.add(blk); return t[i]; }
        }
        const v = Reflect.get(t, k, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    render(spy);
    if (!need.size) break;
    // read them, neighbouring blocks together
    const blocks = [...need].sort((a, b) => a - b);
    for (let i = 0; i < blocks.length;) {
      let j = i;
      while (j + 1 < blocks.length && blocks[j + 1] - blocks[j] <= 2) j++;
      const from = blocks[i] * BLOCK, len = (blocks[j] - blocks[i] + 1) * BLOCK;
      progress(bytesRead, bytesRead + len);
      const b = await read(ram(from), len);
      for (let k = 0; k < len; k += 4) words[(from + k) >>> 2] = be32(b, k);
      for (let blk = blocks[i]; blk <= blocks[j]; blk++) have[blk] = 1;
      i = j + 1;
    }
    if (bytesRead > 6 << 20) throw new Error('the composite needs more of RAM than makes sense');
  }
  const fb = render(words);
  const rgba = new Uint32Array(D.hsize * D.vsize);
  for (let y = 0; y < D.vsize; y++) rgba.set(fb.subarray((D.vstart + y) * SCREEN_W + D.hstart, (D.vstart + y) * SCREEN_W + D.hstart + D.hsize), y * D.hsize);
  return { width: D.hsize, height: D.vsize, rgba, yuyv: toYuyv(rgba, D.hsize, D.vsize), mode: 'compositor', address: R.ymapBaseMaster, regs: R, bytesRead };
}
