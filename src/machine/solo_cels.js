// The SOLO's gfxUnit compositor (cels on a y-map) and its YCbCr -> RGB, as pure functions over a
// RAM image: the emulator's video (solo_video.js) draws every frame with them, and the Bridge's
// web page (pico/web/, through web/boxscreen.js) composites a screenshot of a real box with the
// same code, from the box's memory read through the Bridge.
//
// Ported from the wtvemac MAME driver (solo_asic_video.cpp, BSD-3-Clause, copyright-holders
// FairPlay137, wtvemac), checked against chapter 3 of the SOLO1 ASIC spec.

export const SCREEN_W = 640;
export const SCREEN_H = 480;
export const Y_BLACK = 0x10;
export const Y_RANGE = 0xeb - 0x10;
export const UV_OFFSET = 0x80;

const signed10 = (v) => (v & 0x1ff) | -(v & 0x200);
const signed88 = (v) => ((v << 16) >> 24) + (v & 0xff) / 256;
const signed1010 = (v) => signed10(v >> 10) + (v & 0x3ff) / 1024;
const xsigned1010 = (i, f) => signed10(i) + f / 1024;
const truncTowardInf = (v) => (v > 0 ? Math.ceil(v) : Math.floor(v)) | 0; // INTF_TRUNC
const truncTowardZero = (v) => (v > 0 ? Math.floor(v) : Math.ceil(v)) | 0; // INTR_TRUNC
// texture coordinates are signed 8-bit, centred on the texture base
const maskedTrunc = (v, mask) => ((truncTowardInf(v) & mask) << 24) >> 24;

export const CEL_SIZES = [8, 16, 48, 48];

// Write two pixels from a Y0 Cb Y1 Cr word.
export function put422(fb, p, w, alpha, cel, onlyFirst) {
  const cb = ((w >>> 16) & 0xff) - UV_OFFSET;
  const cr = (w & 0xff) - UV_OFFSET;
  const r = ((0x166 * cr) + UV_OFFSET) >> 8;
  const b = ((0x1c7 * cb) + UV_OFFSET) >> 8;
  const g = ((0x32 * b) + (0x83 * r) + UV_OFFSET) >> 8;
  const y0 = (w >>> 24) & 0xff, y1 = (w >>> 8) & 0xff;
  if (y0 !== 0xff) {
    const y = ((((y0 - Y_BLACK) << 8) + UV_OFFSET) / Y_RANGE) | 0;
    drawPixel(fb, p, cel, alpha, y + r, y - g, y + b);
  }
  if (y1 !== 0xff && !onlyFirst) {
    const y = ((((y1 - Y_BLACK) << 8) + UV_OFFSET) / Y_RANGE) | 0;
    drawPixel(fb, p + 1, cel, alpha, y + r, y - g, y + b);
  }
}

// One 4:4:4 pixel: Y Cb A Cr
export function put444(fb, p, w, cel) {
  let a = (w >>> 8) & 0xff;
  const y0 = (w >>> 24) & 0xff;
  if (a === 0 || y0 === 0xff) return;
  const cr = (((w & 0xff) + UV_OFFSET) & 0xff) - UV_OFFSET;
  const cb = ((((w >>> 16) & 0xff) + UV_OFFSET) & 0xff) - UV_OFFSET;
  const y = ((((y0 - Y_BLACK) << 8) + UV_OFFSET) / Y_RANGE) | 0;
  const r = ((0x166 * cr) + UV_OFFSET) >> 8;
  const b = ((0x1c7 * cb) + UV_OFFSET) >> 8;
  const g = ((0x32 * b) + (0x83 * r) + UV_OFFSET) >> 8;
  drawPixel(fb, p, cel, a, y + r, y - g, y + b);
}

function drawPixel(fb, p, cel, a, r, g, b) {
  let alphaType = 2; // BG_TRANSPARENT
  if (cel) {
    alphaType = cel.alphaType;
    if (a === 0xff || cel.globalAlpha !== 0xff) a = cel.globalAlpha;
  }
  if (a === 0) return;
  if (a !== 0xff) {
    const fa = a, ba = 255 - a;
    const bg = fb[p];
    const rb = bg & 0xff, gb = (bg >>> 8) & 0xff, bb = (bg >>> 16) & 0xff;
    switch (alphaType) {
      case 0: r = (fa * r + ba * rb) / 255 | 0; g = (fa * g + ba * gb) / 255 | 0; b = (fa * b + ba * bb) / 255 | 0; break;
      case 1: r = (fa * r + fa * rb) / 255 | 0; g = (fa * g + fa * gb) / 255 | 0; b = (fa * b + fa * bb) / 255 | 0; break;
      case 2: r = (fa * r) / 255 | 0; g = (fa * g) / 255 | 0; b = (fa * b) / 255 | 0; break;
      case 3: {
        const yb = ((((cel.yBlend + Y_BLACK) << 8) + UV_OFFSET) / Y_RANGE) | 0;
        const crb = ((cel.crBlend + UV_OFFSET) & 0xff) - UV_OFFSET;
        const cbb = ((cel.cbBlend + UV_OFFSET) & 0xff) - UV_OFFSET;
        const r2 = yb + (((0x166 * crb) + UV_OFFSET) >> 8);
        const b2 = yb - (((0x1c7 * cbb) + UV_OFFSET) >> 8);
        const g2 = yb + (((0x32 * b2) + (0x83 * r2) + UV_OFFSET) >> 8);
        r = (fa * r + ba * r2) / 255 | 0; g = (fa * g + ba * g2) / 255 | 0; b = (fa * b + ba * b2) / 255 | 0;
        break;
      }
    }
  }
  fb[p] = pack(r, g, b);
}


// G: the gfxUnit's registers (ymapBase, celsBase and initColor change as it goes); D: the
// window (hstart, hsize, vstart, vsize) on fb, SCREEN_W x SCREEN_H, 0xAABBGGRR
export function drawCels(ram, mask, G, D, fb) {
  const rd = (addr) => ram[(addr & mask) >>> 2];
  G.ymapBase = G.ymapBaseMaster; G.celsBase = G.celsBaseMaster;
  let ymOff = 0;
  for (let ymidx = 0; ymidx < 255; ymidx++) {
    const ym = rd(G.ymapBase + ymOff);
    ymOff += 4;
    const lineCnt = (ym >>> 23) & 0x1ff;
    const lineTop = signed10(ym >>> 13);
    const disabled = (ym >>> 12) & 1;
    const celSize = CEL_SIZES[(ym >>> 10) & 3];
    const celBlk = ym & 0x3ff;
    if (disabled) continue;
    if ((((ym >>> 13) & 0x3ff)) === 0x1ff) break; // termination line
    const data = new Int32Array(12);
    data[2] = 0x00100000; data[3] = 0xff000000 | 0; data[6] = 0x00000100; data[10] = 0xffff0000 | 0; data[11] = 0x00dbdbdb;
    let celPtr = (G.celsBase >>> 0) + (celBlk << 3);
    for (let c = 0; c < 255; c++) {
      for (let i = 0; i < celSize / 4; i++) data[i] = rd(celPtr + i * 4);
      const cel = decodeCel(data);
      if (cel.texType === 6) loadData(G, cel);
      else drawCel(ram, mask, D, fb, lineCnt, lineTop, cel);
      if (cel.isLast) break;
      celPtr += celSize;
    }
  }
}

function loadData(G, cel) {
  switch (cel.loadType) {
    case 4: G.initColor = cel.texBase; break;
    case 1: G.ymapBase = (cel.texBase << 2) & ~0xfc000003; break;
    case 5: G.ymapBase = G.ymapBaseMaster; break;
    case 2: G.celsBase = (cel.texBase << 2) & ~0xfc000003; break;
    case 6: G.celsBase = G.celsBaseMaster; break;
  }
}

function drawCel(ram, mask, D, fb, lineCnt, lineTop, cel) {
  let yTop = D.vstart + ((D.vsize / 2) | 0) + lineTop + cel.topOffset;
  const yBottom = Math.min(D.vstart + D.vsize, yTop + (lineCnt - cel.bottomOffset));
  let yOff = 0;
  if (yTop < D.vstart) { yOff = D.vstart - yTop; yTop = D.vstart; }
  const texBase = cel.texBase << 2;
  const cb = cel.codebookBase;
  for (let y = yTop; y < yBottom; y++, yOff++) {
    let u = cel.ustart + yOff * cel.durowAdjust;
    let v = cel.vstart + yOff * cel.dvrowAdjust;
    const xl = cel.xleft + yOff * cel.dxLeft;
    const xr = cel.xright + yOff * cel.dxRight;
    let xs = D.hstart + ((D.hsize / 2) | 0) + truncTowardZero(xl);
    const xe = D.hstart + Math.min(D.hsize, ((D.hsize / 2) | 0) + truncTowardZero(xr));
    if (xs < D.hstart) { const n = D.hstart - xs; u += cel.dux * n; v += cel.dvx * n; xs = D.hstart; }
    let p = y * SCREEN_W + xs;
    for (let x = xs; x < xe; x += 2, p += 2) {
      const one = (x + 1) === xe;
      switch (cel.texType) {
        case 1: case 4: case 5: { // direct 4:2:2
          const idx = texBase + maskedTrunc(v, cel.vmask) * cel.rowBytes + maskedTrunc(u, cel.umask) * 2;
          const w = ram[(idx & mask) >>> 2];
          u += cel.dux * 2; v += cel.dvx * 2;
          put422(fb, p, w, 0xff, cel, one);
          break;
        }
        case 2: { // VQ8 4:4:4
          let idx = texBase + maskedTrunc(v, cel.vmask) * cel.rowBytes + maskedTrunc(u, cel.umask);
          const i0 = (ram[(idx & mask) >>> 2] >>> ((3 - (idx & 3)) << 3)) & 0xff;
          u += cel.dux; v += cel.dvx;
          idx = texBase + maskedTrunc(v, cel.vmask) * cel.rowBytes + maskedTrunc(u, cel.umask);
          const i1 = (ram[(idx & mask) >>> 2] >>> ((3 - (idx & 3)) << 3)) & 0xff;
          u += cel.dux; v += cel.dvx;
          put444(fb, p, ram[((cb + i0) << 2 & mask) >>> 2], cel);
          if (!one) put444(fb, p + 1, ram[((cb + i1) << 2 & mask) >>> 2], cel);
          break;
        }
        case 7: { // VQ4 4:4:4
          const idx = texBase + maskedTrunc(v, cel.vmask) * cel.rowBytes + ((maskedTrunc(u, cel.umask) / 2) | 0);
          const b = (ram[(idx & mask) >>> 2] >>> ((3 - (idx & 3)) << 3)) & 0xff;
          u += cel.dux; v += cel.dvx;
          put444(fb, p, ram[((cb + ((b >> 4) & 0xf)) << 2 & mask) >>> 2], cel);
          if (!one) put444(fb, p + 1, ram[((cb + (b & 0xf)) << 2 & mask) >>> 2], cel);
          break;
        }
        case 3: { // direct 4:4:4
          let idx = texBase + maskedTrunc(v, cel.vmask) * cel.rowBytes + maskedTrunc(u, cel.umask) * 4;
          const c0 = ram[(idx & mask) >>> 2];
          u += cel.dux; v += cel.dvx;
          idx = texBase + maskedTrunc(v, cel.vmask) * cel.rowBytes + maskedTrunc(u, cel.umask) * 4;
          const c1 = ram[(idx & mask) >>> 2];
          u += cel.dux; v += cel.dvx;
          put444(fb, p, c0, cel);
          if (!one) put444(fb, p + 1, c1, cel);
          break;
        }
        default:
          u += cel.dux * 2; v += cel.dvx * 2;
      }
    }
  }
}

export function pack(r, g, b) {
  r = r < 0 ? 0 : r > 255 ? 255 : r;
  g = g < 0 ? 0 : g > 255 ? 255 : g;
  b = b < 0 ? 0 : b > 255 ? 255 : b;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

export function decodeCel(d) {
  const mode = (d[0] >>> 24) & 0xff;
  const rowlongs = (((d[2] >>> 24) & 0xff) << 4) | ((d[0] >>> 10) & 0xf);
  const duxRaw = ((((d[10] >>> 12) & 0xf) << 12) | (((d[2] >>> 16) & 0xff) << 4) | ((d[10] >>> 8) & 0xf)) & 0xffff;
  return {
    isLast: (mode >> 7) & 1,
    texType: (mode >> 1) & 7,
    alphaType: (mode >> 4) & 3,
    loadType: (mode >> 4) & 7,
    topOffset: (d[0] >>> 16) & 0xff,
    bottomOffset: (d[1] >>> 24) & 0xff,
    texBase: d[1] & 0xffffff,
    rowBytes: (rowlongs + 1) << 2,
    xleft: xsigned1010(d[0] & 0x3ff, (d[7] >>> 20) & 0x3ff),
    xright: xsigned1010(d[2] & 0x3ff, (d[8] >>> 20) & 0x3ff),
    dux: signed88(duxRaw),
    globalAlpha: (d[3] >>> 24) & 0xff,
    codebookBase: d[3] & 0xffffff,
    ustart: signed88((d[4] >>> 16) & 0xffff),
    durowAdjust: signed88(d[4] & 0xffff),
    vstart: signed88((d[6] >>> 16) & 0xffff),
    dvrowAdjust: signed88(d[6] & 0xffff),
    dxLeft: signed1010(d[7] & 0xfffff),
    dxRight: signed1010(d[8] & 0xfffff),
    dvx: signed88(d[9] & 0xffff),
    umask: (d[10] >>> 24) & 0xff,
    vmask: (d[10] >>> 16) & 0xff,
    yBlend: (d[11] >>> 16) & 0xff,
    cbBlend: (d[11] >>> 8) & 0xff,
    crBlend: d[11] & 0xff,
  };
}
