// SOLO1 video: vidUnit (framebuffer DMA), gfxUnit (cel/ymap compositor), dveUnit, divUnit
// (video in), potUnit (pixel output: timing, blanking, interrupts).
//
// Rendering approach and gfxUnit cel/ymap record layouts are ported from the wtvemac MAME
// driver (solo_asic_video.cpp, BSD-3-Clause, copyright-holders FairPlay137, wtvemac),
// checked against chapter 3 of the SOLO1 ASIC spec.

import { BUS_INT_VIDEO } from './solo.js';
import { put422, drawCels, pack, SCREEN_W, SCREEN_H, Y_BLACK, Y_RANGE, UV_OFFSET } from './solo_cels.js';

export { SCREEN_W, SCREEN_H };

// BUS_VIDINTSTAT bits
const VID_DIV = 1 << 5, VID_GFX = 1 << 4, VID_POT = 1 << 3, VID_VID = 1 << 2;

const POT_INT_VSYNCE = 1 << 5, POT_INT_VSYNCO = 1 << 4, POT_INT_HSYNC = 1 << 3;
const VID_INT_DMA = 1 << 2;
const POT_FCNTL_USEGFX = 1 << 3, POT_FCNTL_EN = 1 << 0;
const GFX_FCNTL_EN = 1 << 7;
const VID_DMACNTL_DMAEN = 1 << 2;

const POT_HSTART_OFFSET = 0x77, POT_VSTART_OFFSET = 0x23;



export class SoloVideo {
  constructor(machine) {
    this.m = machine;
    this.solo = machine.solo;
    this.fb = new Uint32Array(SCREEN_W * SCREEN_H); // 0xAABBGGRR (canvas ImageData order)
    this.frameCount = 0;
    this.onFrame = null;
    this.seen = new Set();
    this.fieldCycles = Math.round(machine.cpuHz / 59.94);
    this.reset();
  }

  reset() {
    this.vid = { nstart: 0x80000000 | 0, nsize: 0, dmacntl: 0, cstart: 0, csize: 0, ccnt: 0, vdata: 0, inten: 0, intstat: 0 };
    this.gfx = {
      cntl: 0, ootYcount: 0, ymapBase: 0x80000000 | 0, ymapBaseMaster: 0x80000000 | 0, celsBase: 0x80000000 | 0,
      celsBaseMaster: 0x80000000 | 0, initColor: 0, ycounterInit: 0, pauseCycles: 0, ootCelsBase: 0, ootYmapBase: 0,
      ootCelsOffset: 0, ootYmapCount: 0, termCycleCount: 0, hcounterInit: 0, blankLines: 0, activeLines: 0,
      wbdStart: 0, wbdLsize: 0, wbStride: 0, wbdConfig: 0, inten: 0, intstat: 0,
    };
    this.div = { regs: new Int32Array(0x80 / 4), inten: 0, intstat: 0, gpioOutMask: 0, gpioOut: 0 };
    this.dve = new Map();
    this.pot = {
      vstart: 30, vsize: 420, blankColor: (Y_BLACK << 16) | (UV_OFFSET << 8) | UV_OFFSET,
      hstart: POT_HSTART_OFFSET + 40, hsize: 560, cntl: 0, hintline: 0, inten: 0, intstat: 0,
    };
    this.cline = 0;
    this.fieldStart = this.m.cpu.cycles;
    this.odd = true;
    this.validate();
    this.cacheBlank();
    this.updateSummary();
    this.scheduleField();
  }

  // ------------------------------------------------------------------ timing

  scheduleField() {
    const start = this.m.cpu.cycles;
    this.fieldStart = start;
    this.m.sched.at('vid-field', start + this.fieldCycles, () => this.endField());
    this.scheduleHint();
  }

  scheduleHint() {
    const line = Math.min(this.pot.hintline >>> 0, SCREEN_H - 1);
    const t = this.fieldStart + Math.floor(this.fieldCycles * line / 525);
    if (t > this.m.cpu.cycles) this.m.sched.at('vid-hint', t, () => this.raisePot(POT_INT_HSYNC));
    else this.m.sched.cancel('vid-hint');
  }

  currentLine() {
    return Math.min(524, Math.floor((this.m.cpu.cycles - this.fieldStart) * 525 / this.fieldCycles));
  }

  endField() {
    this.render();
    this.frameCount++;
    if (this.onFrame) this.onFrame(this.fb);
    this.raisePot(POT_INT_VSYNCO);
    this.scheduleField();
  }

  // ------------------------------------------------------------------ interrupts

  updateSummary() {
    const s = this.solo.vidInt;
    let st = 0;
    if (this.div.intstat & this.div.inten) st |= VID_DIV;
    if (this.gfx.intstat & this.gfx.inten) st |= VID_GFX;
    if (this.pot.intstat & this.pot.inten) st |= VID_POT;
    if (this.vid.intstat & this.vid.inten) st |= VID_VID;
    s.stat = st;
    this.solo.updateIrq();
  }

  // Sub-unit interrupt enables also turn on the corresponding summary + bus enables (as the
  // MAME driver does; the WebTV OS relies on this).
  enableSummary(bit) {
    this.solo.vidInt.en |= bit;
    this.solo.busEn |= BUS_INT_VIDEO;
  }

  // Like the hardware (and MAME's set_video_irq), a source only latches while it is enabled:
  // the OS enables HSYNC before installing its handler, so a stale latched bit would fire
  // into no handler ("looping madly in SecondaryDispatch").
  raisePot(bits) { this.pot.intstat |= bits & this.pot.inten; this.updateSummary(); }

  intCleared() { this.updateSummary(); }

  // ------------------------------------------------------------------ registers

  note(off, what, v) {
    const k = what + off;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.m.log(`[video] unhandled ${what} 0400${off.toString(16)}${v !== undefined ? ' = ' + (v >>> 0).toString(16) : ''}`);
  }

  read(off) {
    const V = this.vid, G = this.gfx, P = this.pot;
    switch (off) {
      case 0x3000: return V.cstart;
      case 0x3004: return V.csize;
      case 0x3008: return V.ccnt;
      case 0x300c: return V.nstart;
      case 0x3010: return V.nsize;
      case 0x3014: return V.dmacntl;
      case 0x3038: return V.intstat;
      case 0x303c: return V.inten;
      case 0x3040: return V.vdata;

      case 0x6004: return G.cntl;
      case 0x6010: return G.ootYcount;
      case 0x6014: return G.celsBase;
      case 0x6018: return G.ymapBase;
      case 0x601c: return G.celsBaseMaster;
      case 0x6020: return G.ymapBaseMaster;
      case 0x6024: return G.initColor;
      case 0x6028: return G.ycounterInit;
      case 0x602c: return G.pauseCycles;
      case 0x6030: return G.ootCelsBase;
      case 0x6034: return G.ootYmapBase;
      case 0x6038: return G.ootCelsOffset;
      case 0x603c: return G.ootYmapCount;
      case 0x6040: return G.termCycleCount;
      case 0x6044: return G.hcounterInit;
      case 0x6048: return G.blankLines;
      case 0x604c: return G.activeLines;
      case 0x6060: return G.inten;
      case 0x6068: return G.intstat;
      case 0x6080: case 0x6094: return G.wbdStart;
      case 0x6084: return G.wbdLsize;
      case 0x608c: return G.wbStride;
      case 0x6090: return G.wbdConfig;

      case 0x9080: return P.vstart;
      case 0x9084: return P.vsize;
      case 0x9088: return P.blankColor;
      case 0x908c: return P.hstart;
      case 0x9090: return P.hsize;
      case 0x9094: return P.cntl;
      case 0x9098: return P.hintline;
      case 0x909c: return P.inten;
      case 0x90a0: case 0x90a8: return P.intstat;
      case 0x90ac: return this.currentLine();

      case 0xd000: return 0x00020000;
    }
    if ((off & 0xf000) === 0x8000) {
      const o = off & 0xfff;
      if (o === 0x60) return 0; // DIV_SYNCPHASE
      if (o === 0x64) return this.div.gpioOutMask;
      if (o === 0x68) return this.div.gpioOut & this.div.gpioOutMask;
      if (o === 0x6c) return 0;
      if (o === 0x70 || o === 0x74) return this.div.inten;
      if (o === 0x78 || o === 0x7c) return this.div.intstat;
      if (o < 0x80) return this.div.regs[o >> 2];
    }
    if ((off & 0xf000) === 0x7000) return this.dve.get(off) | 0;
    this.note(off, 'read');
    return 0;
  }

  write(off, v) {
    const V = this.vid, G = this.gfx, P = this.pot;
    switch (off) {
      case 0x300c: V.nstart = v & ~0xfc000003; this.validate(); return;
      case 0x3010: V.nsize = v; this.validate(); return;
      case 0x3014: V.dmacntl = v; this.validate(); return;
      case 0x3138: V.intstat &= ~v; this.updateSummary(); return;
      case 0x303c: V.inten |= v; if (V.inten) this.enableSummary(VID_VID); this.updateSummary(); return;
      case 0x313c: V.intstat &= ~v; V.inten &= ~v; this.updateSummary(); return;
      case 0x3040: V.vdata = v; return;

      case 0x6004: G.cntl = v; return;
      case 0x6010: G.ootYcount = v; return;
      case 0x6014: G.celsBase = v & ~0xfc000003; return;
      case 0x6018: G.ymapBase = v & ~0xfc000003; return;
      case 0x601c: G.celsBaseMaster = v & ~0xfc000003; return;
      case 0x6020: G.ymapBaseMaster = v & ~0xfc000003; return;
      case 0x6024: G.initColor = v; return;
      case 0x6028: G.ycounterInit = v; return;
      case 0x602c: G.pauseCycles = v; return;
      case 0x6030: G.ootCelsBase = v; return;
      case 0x6034: G.ootYmapBase = v; return;
      case 0x6038: G.ootCelsOffset = v; return;
      case 0x603c: G.ootYmapCount = v; return;
      case 0x6040: G.termCycleCount = v; return;
      case 0x6044: G.hcounterInit = v; this.validate(); return;
      case 0x6048: G.blankLines = v; this.validate(); return;
      case 0x604c: G.activeLines = v; this.validate(); return;
      case 0x6060: G.inten |= v; if (G.inten) this.enableSummary(VID_GFX); this.updateSummary(); return;
      case 0x6064: G.intstat &= ~v; G.inten &= ~v; this.updateSummary(); return;
      case 0x6068: G.intstat |= v; this.updateSummary(); return;
      case 0x606c: G.intstat &= ~v; this.updateSummary(); return;
      case 0x6080: G.wbdStart = v & ~0xfc000003; return;
      case 0x6084: G.wbdLsize = v; return;
      case 0x608c: G.wbStride = v; return;
      case 0x6090: G.wbdConfig = v; return;
      case 0x6094: G.wbdStart = v; return;

      case 0x9080: P.vstart = v; this.validate(); return;
      case 0x9084: P.vsize = v; this.validate(); return;
      case 0x9088: P.blankColor = v; this.cacheBlank(); return;
      case 0x908c: P.hstart = v; this.validate(); return;
      case 0x9090: P.hsize = v; this.validate(); return;
      case 0x9094: P.cntl = v; this.validate(); return;
      case 0x9098: P.hintline = v; this.scheduleHint(); return;
      case 0x909c: P.inten |= v; if (P.inten) this.enableSummary(VID_POT); this.updateSummary(); return;
      case 0x90a4: P.intstat &= ~v; P.inten &= ~v; this.updateSummary(); return;
      case 0x90a8: P.intstat &= ~v; this.updateSummary(); return;
    }
    if ((off & 0xf000) === 0x8000) {
      const o = off & 0xfff;
      if (o === 0x64) { this.div.gpioOutMask = v; return; }
      if (o === 0x68) { this.div.gpioOut |= v & this.div.gpioOutMask; return; }
      if (o === 0x168) { this.div.gpioOut &= ~v; return; }
      if (o === 0x70) { this.div.inten |= v; if (this.div.inten) this.enableSummary(VID_DIV); this.updateSummary(); return; }
      if (o === 0x170) { this.div.inten &= ~v; this.div.intstat &= ~v; this.updateSummary(); return; }
      if (o === 0x78) { this.div.intstat |= v; this.updateSummary(); return; }
      if (o === 0x178) { this.div.intstat &= ~v; this.updateSummary(); return; }
      if (o < 0x80) { this.div.regs[o >> 2] = v; return; }
    }
    if ((off & 0xf000) === 0x7000) { this.dve.set(off, v); return; }
    this.note(off, 'write', v);
  }

  // ------------------------------------------------------------------ geometry

  validate() {
    const P = this.pot, G = this.gfx;
    let hsize = Math.min(Math.max(P.hsize >>> 0, 2), SCREEN_W);
    let vsize = Math.min(Math.max(P.vsize >>> 0, 2), SCREEN_H);
    let nstart = this.vid.nstart >>> 0;
    if (P.cntl & POT_FCNTL_USEGFX) {
      if (G.hcounterInit) hsize = Math.min(hsize, 2 * G.hcounterInit);
      if (G.activeLines) vsize = Math.min(vsize, Math.max(2, 2 * G.activeLines - G.blankLines - 2));
    } else {
      nstart += 2 * hsize * 2;
      vsize -= 2;
    }
    let hstart = Math.max((P.hstart | 0) - POT_HSTART_OFFSET, 2);
    let vstart = Math.max((P.vstart | 0) - POT_VSTART_OFFSET, 2);
    if (hstart + hsize > SCREEN_W) hstart = SCREEN_W - hsize;
    if (vstart + vsize > SCREEN_H) vstart = SCREEN_H - vsize;
    this.draw = { hstart, hsize, vstart, vsize, nstart };
  }

  // ------------------------------------------------------------------ colour

  yuvToRgb(y, cb, cr) { // y already range-expanded (0..255), cb/cr signed
    const r = ((0x166 * cr) + UV_OFFSET) >> 8;
    const b = ((0x1c7 * cb) + UV_OFFSET) >> 8;
    const g = ((0x32 * b) + (0x83 * r) + UV_OFFSET) >> 8;
    return [y + r, y - g, y + b];
  }

  cacheBlank() {
    const c = this.pot.blankColor;
    const y = (((((c >> 16) & 0xff) - Y_BLACK) << 8) + UV_OFFSET) / Y_RANGE | 0;
    const [r, g, b] = this.yuvToRgb(y, ((c >> 8) & 0xff) - UV_OFFSET, (c & 0xff) - UV_OFFSET);
    this.blank = pack(r, g, b);
  }

  // ------------------------------------------------------------------ rendering

  render() {
    const fb = this.fb;
    const P = this.pot, D = this.draw;
    if (P.cntl & POT_FCNTL_USEGFX) {
      const enabled = (P.cntl & POT_FCNTL_EN) && (this.gfx.cntl & GFX_FCNTL_EN);
      this.vid.cstart = this.vid.nstart; this.vid.csize = this.vid.nsize;
      fb.fill(this.blank);
      if (enabled) {
        for (let y = D.vstart; y < D.vstart + D.vsize; y++) {
          fb.fill(0xff000000, y * SCREEN_W + D.hstart, y * SCREEN_W + D.hstart + D.hsize);
        }
        if ((this.gfx.ymapBaseMaster >>> 0) !== 0x80000000) this.drawCels();
      }
      return;
    }
    // vidUnit: YCbCr 4:2:2 framebuffer DMA
    const enabled = (P.cntl & POT_FCNTL_EN) && (this.vid.dmacntl & VID_DMACNTL_DMAEN);
    this.vid.cstart = this.vid.nstart; this.vid.csize = this.vid.nsize;
    fb.fill(this.blank);
    if (enabled) {
      const ram = this.m.bus.ram, mask = this.m.bus.ramMask;
      let addr = D.nstart;
      for (let y = D.vstart; y < D.vstart + D.vsize; y++) {
        let p = y * SCREEN_W + (D.hstart & ~1);
        for (let x = 0; x < D.hsize; x += 2) {
          const w = ram[(addr & mask) >>> 2];
          addr += 4;
          this.put422(fb, p, w, 255, null, false);
          p += 2;
        }
      }
      this.vid.ccnt = addr;
    }
    this.vid.intstat |= VID_INT_DMA & this.vid.inten;
    this.updateSummary();
  }

  // ------------------------------------------------------------------ gfxUnit compositor (solo_cels.js)

  put422(fb, p, w, alpha, cel, onlyFirst) { put422(fb, p, w, alpha, cel, onlyFirst); }

  drawCels() { drawCels(this.m.bus.ram, this.m.bus.ramMask, this.gfx, this.draw, this.fb); }
}
