// SOLO1 ASIC: busUnit, romUnit, devUnit, memUnit, sucUnit (debug serial) and the
// interrupt fabric. Video/audio units live in solo_video.js / solo_audio.js.
//
// Register semantics follow the SOLO1 ASIC Engineering Specification (980-03004-F57),
// with behaviour cross-checked against the wtvemac MAME driver (BSD-3-Clause,
// copyright-holders FairPlay137, wtvemac).

import { SoloPport } from './solo_pport.js';

export const BUS_INT_VIDEO = 1 << 7, BUS_INT_AUDIO = 1 << 6, BUS_INT_RIO = 1 << 5,
  BUS_INT_DEV = 1 << 4, BUS_INT_TIMER = 1 << 3, BUS_INT_FENCE = 1 << 2;

export const DEV_INT_GPIO = 1 << 7, DEV_INT_UART = 1 << 6, DEV_INT_SMARTCARD = 1 << 5,
  DEV_INT_PARPORT = 1 << 4, DEV_INT_IROUT = 1 << 3, DEV_INT_IRIN = 1 << 2;

export const RIO_INT_DEVICE0 = 1 << 2, RIO_INT_DEVICE1 = 1 << 3, RIO_INT_DEVICE2 = 1 << 4,
  RIO_INT_DEVICE3 = 1 << 5;

const TIM_INT_SYSTIMER = 1 << 3, TIM_INT_BUSTOUT = 1 << 2;

const RESETCAUSE_SOFTWARE = 1 << 2, RESETCAUSE_WATCHDOG = 1 << 1, RESETCAUSE_SWITCH = 1 << 0;

const SSID_IDLE = 0, SSID_RESET = 1, SSID_PRESENCE = 2, SSID_COMMAND = 3, SSID_READROM = 4,
  SSID_PULSESTART = 5, SSID_PULSEEND = 6, SSID_BIT = 7;

const hex = (v) => (v >>> 0).toString(16).padStart(8, '0');

// A pair of status/enable registers for one interrupt source group, using SOLO's
// set/clear register convention.
class IntGroup {
  constructor(name, onChange) {
    this.name = name; this.stat = 0; this.en = 0; this.onChange = onChange;
  }
  raise(mask) { this.stat |= mask; this.onChange(); }
  lower(mask) { this.stat &= ~mask; this.onChange(); }
  get active() { return (this.stat & this.en) !== 0; }
}

export class Solo {
  constructor(machine, { chipId = 0x03120000, sysConfig = 0x003f8700, serialId, i2c }) {
    this.m = machine;
    this.chipId = chipId;
    this.sysConfig = sysConfig;
    this.serialId = serialId;
    this.i2c = i2c;
    this.log = machine.log;
    this.video = null; // set by machine
    this.audio = null;
    this.unknownLogged = new Set();
    this.debugOut = (ch) => {};
    this.resetCause = RESETCAUSE_SWITCH;
    this.pport = new SoloPport({ onIrq: (st) => this.setDevIrq(DEV_INT_PARPORT, st), log: this.log });
    this.reset();
  }

  reset() {
    this.chpcntl = 0x0001ffff; // ALIASROM=1, TOCOUNT=0xffff at reset
    this.wdEnable = false;
    this.wdValue = 0;
    this.errEnable = 0; this.errStat = 0;
    // WebTV OS quirk: after the modem ISR reads a 0x7e (PPP flag) byte it calls the PPP layer and
    // then reloads its UART base as 0xa4000000 (the busUnit) instead of 0xbe000000, so its next
    // "LSR" and "IIR" reads hit BUS_ERREN and BUS_INTSTAT. Answer them as "no RX data" and "no
    // interrupt pending" so the handler exits; the next modem interrupt reloads the right base.
    // (Workaround after wtvemac MAME's do7e_hack in solo_asic.cpp, BSD-3-Clause.)
    this.modem7e = false;
    this.fence = new Int32Array(8);
    this.lowRd = [0, 0]; this.lowWr = [0, 0];
    this.tcompare = 0;
    this.jfence = new Int32Array(4);
    this.bootMode = 0; this.useBootMode = 0;

    const upd = () => this.updateIrq();
    this.busEn = 0;
    this.gpioInt = new IntGroup('gpio', () => this.subChanged());
    this.gpioPol = 0;
    this.devInt = new IntGroup('dev', upd);
    this.rioInt = new IntGroup('rio', upd);
    this.timInt = new IntGroup('tim', upd);
    this.vidInt = new IntGroup('vid', upd); // summary for the video units (filled by video)
    this.audInt = new IntGroup('aud', upd);
    this.busStatSoft = 0; // bits set through BUS_INTSTAT_S

    this.memCntl = 3; this.memRefCnt = 0x400; this.memData = 0; this.memCmd = 0; this.memTiming = 0xadbadffa;
    this.romCntl0 = 0; this.romCntl1 = 0;

    this.led = 0xffffffff;
    this.idCntl = 0; this.idState = SSID_IDLE; this.idBit = 0; this.idBitIdx = 0;
    this.nvCntl = 0;
    this.gpioOut = 0; this.gpioEn = 0; this.gpioInput = 0xffffffff;
    this.irData = [];
    this.irStat = 0; this.irSample = 0; this.irReject = 0;
    this.pport.reset();

    this.dbgRx = [];
    this.updateIrq();
  }

  // ------------------------------------------------------------------ interrupts

  subChanged() {
    if (this.gpioInt.active) this.devInt.stat |= DEV_INT_GPIO; else this.devInt.stat &= ~DEV_INT_GPIO;
    this.updateIrq();
  }

  busStat() {
    let s = this.busStatSoft;
    if (this.vidInt.active) s |= BUS_INT_VIDEO;
    if (this.audInt.active) s |= BUS_INT_AUDIO;
    if (this.rioInt.active) s |= BUS_INT_RIO;
    if (this.devInt.active) s |= BUS_INT_DEV;
    if (this.timInt.active) s |= BUS_INT_TIMER;
    if (this.errStat & this.errEnable) s |= BUS_INT_FENCE;
    return s;
  }

  updateIrq() {
    const pending = (this.busStat() & this.busEn) !== 0;
    this.m.cpu.setIrqLine(0, pending);
  }

  // Called by peripherals
  setDevIrq(mask, state) { state ? this.devInt.raise(mask) : this.devInt.lower(mask); }
  setRioIrq(mask, state) { state ? this.rioInt.raise(mask) : this.rioInt.lower(mask); }
  setGpioIrq(mask, state) { state ? this.gpioInt.raise(mask) : this.gpioInt.lower(mask); }

  // ------------------------------------------------------------------ timer

  tcount() { return (this.m.cpu.cycles / 2) >>> 0; }

  scheduleTimer() {
    this.m.sched.cancel('solo-timer');
    if (!this.tcompare) return;
    const now = this.tcount();
    let delta = (this.tcompare - now) >>> 0;
    if (delta === 0) delta = 0x100000000;
    this.m.sched.at('solo-timer', this.m.cpu.cycles + delta * 2, () => {
      this.timInt.raise(TIM_INT_SYSTIMER);
    });
  }

  // ------------------------------------------------------------------ MMIO

  read(pa, size) {
    const off = pa & 0xffff;
    if (size !== 4) {
      // all SOLO registers are 32-bit; emulate narrow reads from the word
      const w = this.read32(off & ~3);
      if (size === 2) return (w >>> ((2 - (off & 2)) << 3)) & 0xffff;
      return (w >>> ((3 - (off & 3)) << 3)) & 0xff;
    }
    return this.read32(off);
  }

  write(pa, v, size) {
    const off = pa & 0xffff;
    if (size !== 4) {
      // narrow writes: SOLO sees the byte lanes; treat value as right-aligned in its lane
      const sh = size === 2 ? ((2 - (off & 2)) << 3) : ((3 - (off & 3)) << 3);
      v = (v << sh) | 0;
      this.unknown(off, 'narrow-write' + size);
    }
    this.write32(off & ~3, v);
  }

  unknown(off, what, v) {
    const key = what + off;
    if (!this.unknownLogged.has(key)) {
      this.unknownLogged.add(key);
      this.log(`[solo] unhandled ${what} 0400${off.toString(16).padStart(4, '0')}${v !== undefined ? ' = ' + hex(v) : ''} pc=${hex(this.m.cpu.curPC)}`);
    }
  }

  read32(off) {
    const unit = off >>> 12;
    switch (unit) {
      case 0x0: return this.busRead(off & 0xfff);
      case 0x1: return this.romRead(off & 0xfff);
      case 0x4: return this.devRead(off & 0xfff);
      case 0x5: return this.memRead(off & 0xfff);
      case 0xa: return this.sucRead(off & 0xfff);
      case 0x2: case 0xb: case 0xe: return this.audio.read(off);
      case 0x8: if ((off & 0xfff) >= 0x40 && (off & 0xfff) <= 0x5f) return this.audio.read(off); return this.video.read(off);
      case 0x3: case 0x6: case 0x7: case 0x9: case 0xd: return this.video.read(off);
    }
    this.unknown(off, 'read');
    return 0;
  }

  write32(off, v) {
    const unit = off >>> 12;
    switch (unit) {
      case 0x0: this.busWrite(off & 0xfff, v); return;
      case 0x1: this.romWrite(off & 0xfff, v); return;
      case 0x4: this.devWrite(off & 0xfff, v); return;
      case 0x5: this.memWrite(off & 0xfff, v); return;
      case 0xa: this.sucWrite(off & 0xfff, v); return;
      case 0x2: case 0xb: case 0xe: this.audio.write(off, v); return;
      case 0x8: if ((off & 0xfff) >= 0x40 && (off & 0xfff) <= 0x5f) { this.audio.write(off, v); return; } this.video.write(off, v); return;
      case 0x3: case 0x6: case 0x7: case 0x9: case 0xd: this.video.write(off, v); return;
    }
    this.unknown(off, 'write', v);
  }

  // ------------------------------------------------------------------ busUnit (0x0000)

  // Interrupt group registers: stat at R/W offset, _S (set) offset, _C (clear) at +0x100;
  // enable registers similarly.
  busRead(o) {
    switch (o) {
      case 0x000: return this.chipId;
      case 0x004: return this.chpcntl;
      case 0x008: case 0x108:
        if (this.modem7e) { this.modem7e = false; return 0x01; } // see modem7e below
        return this.busStat() & this.busEn;
      case 0x050: return this.busStat();
      case 0x00c: case 0x10c: return this.busEn;
      case 0x010: case 0x110: case 0x054: return this.errStat;
      case 0x014: case 0x114: if (this.modem7e) return 0; return this.errEnable;
      case 0x018: return 0;
      case 0x01c: case 0x020: case 0x024: case 0x028: case 0x02c: return this.fence[(o - 0x1c) >> 2];
      case 0x030: return this.wdValue;
      case 0x034: return this.lowRd[0];
      case 0x038: return this.lowRd[1];
      case 0x03c: return this.lowWr[0];
      case 0x040: return this.lowWr[1];
      case 0x048: return this.tcount();
      case 0x04c: return this.tcompare;
      case 0x058: case 0x060: case 0x158: return this.gpioInt.stat;
      case 0x05c: case 0x15c: return this.gpioInt.en;
      case 0x064: return this.gpioPol;
      case 0x068: case 0x06c: case 0x168: return this.audInt.stat;
      case 0x070: case 0x170: return this.audInt.en;
      case 0x074: case 0x078: case 0x174: return this.devInt.stat;
      case 0x07c: case 0x17c: return this.devInt.en;
      case 0x080: case 0x084: case 0x180: return this.vidInt.stat;
      case 0x088: case 0x188: return this.vidInt.en;
      case 0x08c: case 0x090: case 0x18c: return this.rioInt.stat;
      case 0x094: return this.rioPol || 0;
      case 0x098: case 0x198: return this.rioInt.en;
      case 0x09c: case 0x0a0: case 0x19c: return this.timInt.stat;
      case 0x0a4: case 0x1a4: return this.timInt.en;
      case 0x0a8: return this.resetCause;
      case 0x0b0: case 0x0b4: case 0x0b8: case 0x0bc: return this.jfence[(o - 0xb0) >> 2];
      case 0x0c8: return this.bootMode;
      case 0x0cc: return this.useBootMode;
    }
    this.unknown(o, 'read');
    return 0;
  }

  busWrite(o, v) {
    switch (o) {
      case 0x004: this.writeChpcntl(v); return;
      case 0x008: case 0x050: this.busStatSoft |= v & 0xff; this.updateIrq(); return;
      case 0x108: this.busStatSoft &= ~v; this.clearBusSources(v); this.updateIrq(); return;
      case 0x00c: this.busEn |= v; this.updateIrq(); return;
      case 0x10c: this.busEn &= ~v; this.updateIrq(); return;
      case 0x010: case 0x054: this.errStat |= v & 0xff; this.updateIrq(); return;
      case 0x110: this.errStat &= ~v; this.updateIrq(); return;
      case 0x014: this.errEnable |= v & 0xff; this.updateIrq(); return;
      case 0x114: this.errEnable &= ~v; this.updateIrq(); return;
      case 0x01c: case 0x020: case 0x024: case 0x028: case 0x02c: this.fence[(o - 0x1c) >> 2] = v; return;
      case 0x030: this.wdValue = v; return;
      case 0x118: this.m.watchdogKick && this.m.watchdogKick(); return;
      case 0x034: this.lowRd[0] = v; return;
      case 0x038: this.lowRd[1] = v; return;
      case 0x03c: this.lowWr[0] = v; return;
      case 0x040: this.lowWr[1] = v; return;
      case 0x048: return; // TCOUNT write ignored
      case 0x04c: this.tcompare = v >>> 0; this.timInt.lower(TIM_INT_SYSTIMER); this.scheduleTimer(); return;
      case 0x058: case 0x060: this.gpioInt.raise(v); return;
      case 0x158: this.gpioInt.lower(v); return;
      case 0x05c: this.gpioInt.en |= v; if (this.gpioInt.en) { this.devInt.en |= DEV_INT_GPIO; this.busEn |= BUS_INT_DEV; } this.subChanged(); return;
      case 0x15c: this.gpioInt.en &= ~v; this.subChanged(); return;
      case 0x064: this.gpioPol = v; return;
      case 0x068: case 0x06c: this.audInt.raise(v); return;
      case 0x168: this.audInt.lower(v); this.audio.intCleared && this.audio.intCleared(v); return;
      case 0x070: this.audInt.en |= v; if (this.audInt.en) this.busEn |= BUS_INT_AUDIO; this.updateIrq(); return;
      case 0x170: this.audInt.en &= ~v; this.updateIrq(); return;
      case 0x074: case 0x078: this.devInt.raise(v); return;
      case 0x174: this.devInt.lower(v); this.devIntCleared(v); return;
      // The OS never touches BUS_INTEN for the devUnit; as in MAME, enabling any second-level
      // dev interrupt also enables the BUS_INT_DEV summary bit.
      case 0x07c: this.devInt.en |= v; if (this.devInt.en) this.busEn |= BUS_INT_DEV; this.updateIrq(); return;
      case 0x17c: this.devInt.en &= ~v; this.updateIrq(); return;
      case 0x080: case 0x084: this.vidInt.raise(v); return;
      case 0x180: this.vidInt.lower(v); this.video.intCleared && this.video.intCleared(v); return;
      case 0x088: this.vidInt.en |= v; this.updateIrq(); return;
      case 0x188: this.vidInt.en &= ~v; this.updateIrq(); return;
      case 0x08c: case 0x090: this.rioInt.raise(v); return;
      case 0x18c: this.rioInt.lower(v); this.rioIntCleared(v); return;
      case 0x094: this.rioPol = v; return;
      case 0x098: this.rioInt.en |= v; if (this.rioInt.en) this.busEn |= BUS_INT_RIO; this.updateIrq(); return;
      case 0x198: this.rioInt.en &= ~v; this.updateIrq(); return;
      case 0x09c: case 0x0a0: this.timInt.raise(v); return;
      case 0x19c: this.timInt.lower(v); return;
      case 0x0a4: this.timInt.en |= v; if (this.timInt.en) this.busEn |= BUS_INT_TIMER; this.updateIrq(); return;
      case 0x1a4: this.timInt.en &= ~v; this.updateIrq(); return;
      // A write with the software bit resets the box and leaves the bits written as the cause:
      // the OS's Reboot and the boot ROM both write 7, and the OS's ColdBooted() takes a boot
      // type of 0 or 7 as cold (DetermineBootType); a warm reboot is marked by 'fast' in RAM
      // at 0xa0000400 instead. VERIFY on hardware.
      case 0x0a8:
        if (v & RESETCAUSE_SOFTWARE) { this.resetCause = v & 7; this.m.requestReset('software'); }
        else this.resetCause |= v;
        return;
      case 0x0ac: this.resetCause &= ~v; return;
      case 0x0b0: case 0x0b4: case 0x0b8: case 0x0bc: this.jfence[(o - 0xb0) >> 2] = v; return;
      case 0x0c8: this.bootMode = v; return;
      case 0x0cc: this.useBootMode = v; return;
    }
    this.unknown(o, 'write', v);
  }

  // Clearing a summary bit in BUS_INTSTAT also clears the underlying sources.
  clearBusSources(v) {
    if (v & BUS_INT_TIMER) this.timInt.stat = 0;
  }

  writeChpcntl(v) {
    const WD = 0xc0000000;
    if ((this.chpcntl ^ v) & WD) {
      const seq = (v >>> 30) & 3, old = (this.chpcntl >>> 30) & 3;
      if (!this.wdEnable && seq === 3 && seq > old) this.wdEnable = true;
      else if (this.wdEnable && seq === 0 && seq < old) this.wdEnable = false;
    }
    this.chpcntl = v;
  }

  devIntCleared(v) {
    // IR input stays asserted while there is still data waiting
    if ((v & DEV_INT_IRIN) && this.ir && this.ir.pending()) this.devInt.raise(DEV_INT_IRIN);
    if ((v & DEV_INT_PARPORT) && this.pport.irq) this.devInt.raise(DEV_INT_PARPORT);
  }

  rioIntCleared(v) {
    if (this.m.rioLevel) {
      const lvl = this.m.rioLevel();
      if (lvl & v) this.rioInt.raise(lvl & v);
    }
  }

  // ------------------------------------------------------------------ romUnit (0x1000)

  romRead(o) {
    switch (o) {
      case 0x000: return this.sysConfig;
      case 0x004: return this.romCntl0;
      case 0x008: return this.romCntl1;
    }
    this.unknown(0x1000 + o, 'read');
    return 0;
  }
  romWrite(o, v) {
    switch (o) {
      case 0x004: this.romCntl0 = v; return;
      case 0x008: this.romCntl1 = v; return;
    }
    this.unknown(0x1000 + o, 'write', v);
  }

  // ------------------------------------------------------------------ devUnit (0x4000)

  devRead(o) {
    switch (o) {
      case 0x000: return this.ir ? this.ir.readIrOld() : 0;
      case 0x004: return this.led;
      case 0x008: return this.ssidRead();
      case 0x00c: return (this.nvCntl & 0x1e) | (this.i2c.scl << 5) | (this.i2c.sda & 1); // DEV_IICCNTL
      case 0x010: return (this.gpioInput & ~this.gpioEn) | (this.gpioOut & this.gpioEn);
      case 0x014: case 0x114: return this.gpioOut;
      case 0x018: case 0x118: return this.gpioEn;
      case 0x020: return this.ir ? this.ir.read(0x20) : 0;
      case 0x024: return this.ir ? this.ir.read(0x24) : 0;
      case 0x028: return this.ir ? this.ir.read(0x28) : 0;
      case 0x02c: return this.ir ? this.ir.read(0x2c) : 0;
    }
    if (o >= 0x200 && o < 0x230) return this.pport.read(o - 0x200);
    this.unknown(0x4000 + o, 'read');
    return 0;
  }

  devWrite(o, v) {
    switch (o) {
      case 0x004: {
        const old = this.led; this.led = v;
        if (((old ^ v) & 7) && this.m.onLeds) this.m.onLeds(v);
        return;
      }
      case 0x008: this.ssidWrite(v); return;
      case 0x00c: {
        // bit4 CLKOEN, bit3 CLKO, bit2 DATAOEN, bit1 DATAO (a '1' tristates -> pulled high)
        this.nvCntl = v & 0x1e;
        const scl = (v & 0x10) ? ((v >> 3) & 1) : 1;
        const sda = (v & 4) ? ((v >> 1) & 1) : 1;
        this.i2c.set(scl, sda);
        return;
      }
      case 0x010: return;
      case 0x014: this.gpioOut |= v; this.m.onGpio && this.m.onGpio(this.gpioOut, v, 0); return;
      case 0x114: this.gpioOut &= ~v; this.m.onGpio && this.m.onGpio(this.gpioOut, 0, v); return;
      case 0x018: this.gpioEn |= v; return;
      case 0x118: this.gpioEn &= ~v; return;
      case 0x020: case 0x024: case 0x02c: if (this.ir) this.ir.write(o, v); return;
    }
    if (o >= 0x200 && o < 0x230) { this.pport.write(o - 0x200, v); return; }
    this.unknown(0x4000 + o, 'write', v);
  }

  // DS2401 1-wire serial id, bit-banged through DEV_IDCNTL. Simplified state machine
  // (timing is ignored), as in the MAME driver.
  ssidRead() {
    this.idBit = 0;
    if (this.idState === SSID_PRESENCE) {
      this.idBit = 0; this.idState = SSID_COMMAND; this.idBitIdx = 0;
    } else if (this.idState === SSID_PULSEEND) {
      this.idState = SSID_BIT;
    } else if (this.idState === SSID_BIT) {
      this.idState = SSID_READROM;
      this.idBit = (this.serialId[this.idBitIdx >> 3] >> (this.idBitIdx & 7)) & 1;
      this.idBitIdx++;
      if (this.idBitIdx === 64) { this.idState = SSID_IDLE; this.idBitIdx = 0; }
    }
    return this.idCntl | (this.idBit & 1);
  }

  ssidWrite(v) {
    this.idCntl = v & 2;
    if (v & 2) {
      if (this.idState === SSID_RESET) this.idState = SSID_PRESENCE;
      else if (this.idState === SSID_COMMAND) {
        this.idBitIdx++;
        if (this.idBitIdx === 8) { this.idState = SSID_READROM; this.idBitIdx = 0; }
      } else if (this.idState === SSID_PULSESTART) this.idState = SSID_PULSEEND;
    } else {
      if (this.idState === SSID_IDLE) this.idState = SSID_RESET;
      else if (this.idState === SSID_READROM) this.idState = SSID_PULSESTART;
    }
  }

  // ------------------------------------------------------------------ memUnit (0x5000)

  memRead(o) {
    switch (o) {
      case 0x000: return this.memCntl;
      case 0x004: return this.memRefCnt;
      case 0x008: return this.memData;
      case 0x00c: return this.memCmd;
      case 0x010: return this.memTiming;
    }
    this.unknown(0x5000 + o, 'read');
    return 0;
  }
  memWrite(o, v) {
    switch (o) {
      case 0x000: this.memCntl = v; return;
      case 0x004: this.memRefCnt = v; return;
      case 0x008: this.memData = v; return;
      case 0x00c: this.memCmd = v; return;
      case 0x010: this.memTiming = v; return;
    }
    this.unknown(0x5000 + o, 'write', v);
  }

  // ------------------------------------------------------------------ sucUnit (0xa000): debug serial

  sucRead(o) {
    switch (o) {
      case 0x00c: return 0;          // TFFCNT: transmit FIFO always drained
      case 0x010: return 0x100;      // TFFMAX
      case 0x040: return this.dbgRx.length ? this.dbgRx.shift() : 0; // RFFHR
      case 0x04c: return this.dbgRx.length; // RFFCNT
      case 0x050: return 0x100;      // RFFMAX
      case 0xab8: return 1 << 4;     // SUCSC0_GPIOVAL
    }
    this.unknown(0xa000 + o, 'read');
    return 0;
  }
  sucWrite(o, v) {
    switch (o) {
      case 0x000: this.debugOut(v & 0xff); return; // TFFHR
    }
    this.unknown(0xa000 + o, 'write', v);
  }

  debugInput(byte) {
    // The OS polls RFFCNT; raising DEV_INT_UART makes it panic with "Unhandled Interrupt: UART".
    this.dbgRx.push(byte & 0xff);
  }
}
