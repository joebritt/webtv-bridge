// SOLO1 audUnit: double-buffered audio output/input DMA, plus the divUnit audio and modUnit
// (soft modem) register blocks as plain register files.
//
// DMA buffer handling follows the wtvemac MAME driver (solo_asic_audio.cpp, BSD-3-Clause,
// copyright-holders FairPlay137, wtvemac): when the current buffer finishes, the "next"
// registers are latched into "current" and an AUDDMAOUT interrupt asks the OS to queue the
// following buffer.

import { BUS_INT_AUDIO } from './solo.js';

const AUD_INT_DMAOUT = 1 << 2, AUD_INT_DMAIN = 1 << 3;
const DMAEN = 1 << 2, NV = 1 << 1, NVF = 1 << 0;
const CHUNK = 256; // samples per DMA service tick

export class SoloAudio {
  constructor(machine) {
    this.m = machine;
    this.solo = machine.solo;
    this.sampleRate = 44100;
    this.onSamples = null; // (Float32Array interleaved stereo) => void
    this.regs = new Map();
    this.seen = new Set();
    this.reset();
  }

  reset() {
    this.o = { cstart: 0, csize: 0, cconfig: 0, ccnt: 0, cend: 0, valid: false, nstart: 0x80000000 | 0, nsize: 0, nconfig: 0, dmacntl: 0 };
    this.i = { cstart: 0, csize: 0, ccnt: 0, cend: 0, valid: false, nstart: 0x80000000 | 0, nsize: 0, dmacntl: 0 };
    this.last = [0, 0];
    this.schedule();
  }

  schedule() {
    const cycles = Math.floor(this.m.cpuHz * CHUNK / this.sampleRate);
    this.m.sched.after('aud-tick', cycles, () => { this.tick(); this.schedule(); });
  }

  raise(bit) { this.solo.audInt.raise(bit); }

  tick() {
    const out = new Float32Array(CHUNK * 2);
    const o = this.o, ram = this.m.bus.ram, mask = this.m.bus.ramMask;
    let s = 0;
    if (o.dmacntl & DMAEN) {
      if (!o.valid && (o.dmacntl & NV) && (o.nstart >>> 0) !== 0x80000000) this.latchOut();
      while (o.valid && s < CHUNK) {
        const w = ram[(o.ccnt & mask) >>> 2];
        let l, r;
        switch (o.cconfig & 3) {
          case 0: l = (w >> 16) / 32768; r = ((w << 16) >> 16) / 32768; break;    // 16-bit stereo
          case 1: l = r = (w >> 16) / 32768; break;                                // 16-bit mono
          case 2: l = (w >> 24) / 128; r = ((w << 8) >> 24) / 128; break;          // 8-bit stereo
          default: l = r = (w >> 24) / 128; break;                                 // 8-bit mono
        }
        out[2 * s] = l; out[2 * s + 1] = r;
        this.last[0] = l; this.last[1] = r;
        s++;
        o.ccnt = (o.ccnt + 4) | 0;
        if ((o.ccnt >>> 0) >= (o.cend >>> 0)) {
          o.valid = false;
          if ((o.dmacntl & NV) && (o.nstart >>> 0) !== 0x80000000) this.latchOut();
        }
      }
    }
    // underrun: decay the last sample to avoid clicks
    for (; s < CHUNK; s++) {
      this.last[0] *= 0.995; this.last[1] *= 0.995;
      out[2 * s] = this.last[0]; out[2 * s + 1] = this.last[1];
    }
    this.serviceInput();
    if (this.onSamples) this.onSamples(out);
  }

  latchOut() {
    const o = this.o;
    o.cstart = o.nstart; o.csize = o.nsize; o.cconfig = o.nconfig;
    o.ccnt = o.cstart; o.cend = (o.cstart + o.csize) | 0;
    o.valid = o.csize > 0;
    if (!(o.dmacntl & NVF)) o.dmacntl &= ~NV;
    this.raise(AUD_INT_DMAOUT);
  }

  // Audio input (microphone): fill with silence at the sample rate.
  serviceInput() {
    const i = this.i;
    if (!(i.dmacntl & DMAEN)) return;
    if (!i.valid && (i.dmacntl & NV) && (i.nstart >>> 0) !== 0x80000000) {
      i.cstart = i.nstart; i.csize = i.nsize; i.ccnt = i.cstart; i.cend = (i.cstart + i.csize) | 0; i.valid = i.csize > 0;
      if (!(i.dmacntl & NVF)) i.dmacntl &= ~NV;
    }
    if (!i.valid) return;
    const ram = this.m.bus.ram, mask = this.m.bus.ramMask;
    for (let s = 0; s < CHUNK && i.valid; s++) {
      ram[(i.ccnt & mask) >>> 2] = 0;
      i.ccnt = (i.ccnt + 4) | 0;
      if ((i.ccnt >>> 0) >= (i.cend >>> 0)) { i.valid = false; this.raise(AUD_INT_DMAIN); }
    }
  }

  intCleared() {}

  note(off, what, v) {
    const k = what + off;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.m.log(`[audio] ${what} 0400${off.toString(16)}${v !== undefined ? ' = ' + (v >>> 0).toString(16) : ''}`);
  }

  read(off) {
    const o = this.o, i = this.i;
    switch (off) {
      case 0x2000: return o.cstart;
      case 0x2004: return o.csize;
      case 0x2008: return o.cconfig;
      case 0x200c: return o.ccnt;
      case 0x2010: return o.nstart;
      case 0x2014: return o.nsize;
      case 0x2018: return o.nconfig;
      case 0x201c: return o.dmacntl;
      case 0x2020: return i.cstart;
      case 0x2024: return i.csize;
      case 0x202c: return i.ccnt;
      case 0x2030: return i.nstart;
      case 0x2034: return i.nsize;
      case 0x203c: return i.dmacntl;
    }
    if (!this.regs.has(off)) this.note(off, 'read');
    return this.regs.get(off) | 0;
  }

  write(off, v) {
    const o = this.o, i = this.i;
    switch (off) {
      case 0x2010: o.nstart = v & ~0xfc000003; return;
      case 0x2014: o.nsize = v; return;
      case 0x2018: o.nconfig = v; return;
      case 0x201c: o.dmacntl = v; if (!(v & DMAEN)) o.valid = false; return;
      case 0x2030: i.nstart = v & ~0xfc000003; return;
      case 0x2034: i.nsize = v; return;
      case 0x203c: i.dmacntl = v; if (!(v & DMAEN)) i.valid = false; return;
    }
    if (!this.regs.has(off)) this.note(off, 'write', v);
    this.regs.set(off, v);
  }
}

export { BUS_INT_AUDIO };
