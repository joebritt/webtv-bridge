// WebTV LC2 (SOLO1) machine: Sony INT-W200 / Philips MAT972 class "WebTV Plus".
//   CPU: IDT R4640 big-endian @ 167MHz (bus clock = CPU/2)
//   RAM: 8MB SDRAM, ROM: 2MB boot ROM at 0x1f800000 (mirrored up to 0x1fffffff)
//   IDE disk on RIO device 1, hardware modem UART on RIO device 0.

import { MipsCpu } from '../cpu/mips.js';
import { Bus } from './bus.js';
import { Scheduler } from './sched.js';
import { Solo, RIO_INT_DEVICE0, RIO_INT_DEVICE1 } from './solo.js';
import { I2cBus, I2cRegDevice, Eeprom24c01, makeSerialId } from './i2c.js';
import { IdeDisk } from './ide.js';
import { Uart16550 } from './uart16550.js';
import { Modem } from './modem.js';
import { LptBridge } from './lptbridge.js';
import { RegStub } from './regstub.js';
import { SoloVideo } from './solo_video.js';
import { SoloAudio } from './solo_audio.js';
import { SoloIr } from './ir.js';

export const CPU_HZ = 167000000;

/** Convert a raw ROM image (bytes in big-endian order) into native 32-bit words. */
export function romWords(bytes) {
  const n = bytes.length >>> 2;
  const w = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    w[i] = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
  }
  return w;
}

class MmioAdapter {
  constructor(base, stride, dev) { this.base = base; this.stride = stride; this.dev = dev; }
  read(pa) { return this.dev.read(((pa - this.base) / this.stride) | 0); }
  write(pa, v) { this.dev.write(((pa - this.base) / this.stride) | 0, v); }
}

export class WebTV {
  constructor({ rom, disk = null, nvram = null, serial = 0x0000c0ffee01, log = console.log, makeVideo, makeAudio, makeIr }) {
    this.log = log;
    this.bus = new Bus({ ramSize: 8 << 20, rom: romWords(rom) });
    this.bus.log = log;
    this.cpu = new MipsCpu(this.bus);
    this.cpu.log = log;
    // Debug OS builds call Debugger() (break 0x1c800) on soft assertions, which drops into the
    // serial debug monitor. By default log it and carry on, as if no debugger were attached.
    this.skipDebugger = true;
    this.cpu.breakHook = (op, pc) => {
      if (!this.skipDebugger || ((op >>> 6) & 0xfffff) !== 0x1c800) return false;
      const ra = this.cpu.gprL[31] >>> 0;
      log(`[debugger] Debugger() called from ${(ra - 8).toString(16)}; continuing`);
      return true;
    };
    this.sched = new Scheduler(this.cpu);
    this.cpuHz = CPU_HZ;

    // IIC bus devices
    this.i2c = new I2cBus();
    this.nvram = new Eeprom24c01(nvram);
    this.i2c.attach(0xa0, this.nvram);
    this.i2c.attach(0x88, new I2cRegDevice('bt827'));
    this.i2c.attach(0x8c, new I2cRegDevice('saa7187'));
    this.i2c.attach(0xb6, new I2cRegDevice('audenc'));
    this.i2c.attach(0xc2, new I2cRegDevice('tuner'));

    this.solo = new Solo(this, { serialId: makeSerialId(serial), i2c: this.i2c });
    this.solo.video = makeVideo ? makeVideo(this) : new SoloVideo(this);
    this.solo.audio = makeAudio ? makeAudio(this) : new SoloAudio(this);
    this.solo.ir = makeIr ? makeIr(this) : new SoloIr(this);
    this.ir = this.solo.ir;
    this.bus.map(0x04000000, 0x0400ffff, this.solo);

    // RIO devices
    this.modem = new Uart16550({ log, onIrq: (s) => this.solo.setRioIrq(RIO_INT_DEVICE0, s) });
    const modemIo = new MmioAdapter(0x1e000000, 4, this.modem);
    modemIo.read = (pa) => {
      const reg = ((pa - 0x1e000000) / 4) | 0, v = this.modem.read(reg);
      if (reg === 0 && v === 0x7e && !this.modem.dlab) this.solo.modem7e = true; // see Solo.modem7e
      return v;
    };
    this.bus.map(0x1e000000, 0x1e00001f, modemIo);
    this.modemLine = new Modem(this, this.modem);
    // LPT modem bridge on the parallel port (used by OS builds patched with tools/lptpatch.mjs)
    this.lptBridge = new LptBridge(this);
    this.ide = new IdeDisk(this, disk, { onIrq: (s) => this.solo.setRioIrq(RIO_INT_DEVICE1, s) });
    this.bus.map(0x1e400000, 0x1e80001f, this.ide);
    this.rioLevel = () => (this.modem.irq ? RIO_INT_DEVICE0 : 0) | (this.ide.irq && !(this.ide.devCtl & 2) ? RIO_INT_DEVICE1 : 0);

    this.resetPending = null;
    this.stopped = false;
    this.onReset = null;
  }

  // AC power removed and applied again: RAM is lost and the reset cause is the switch
  powerCycle() {
    this.bus.ram.fill(0);
    this.requestReset('power cycle');
    this.solo.resetCause = 1;
  }

  requestReset(why) {
    this.resetPending = why;
    this.cpu.stopRequested = true;
  }

  doReset() {
    this.log(`[machine] reset (${this.resetPending})`);
    this.resetPending = null;
    this.cpu.reset();
    this.solo.reset();
    this.ide.reset();
    this.modem.reset();
    this.modemLine.reset();
    this.lptBridge.reset();
    this.sched.events = [];
    if (this.solo.video.reset) this.solo.video.reset();
    if (this.solo.audio.reset) this.solo.audio.reset();
    if (this.solo.ir && this.solo.ir.reset) this.solo.ir.reset();
    if (this.onReset) this.onReset();
  }

  /** Run for approximately `budget` CPU cycles (instructions). */
  run(budget) {
    const cpu = this.cpu;
    const end = cpu.cycles + budget;
    while (cpu.cycles < end && !this.stopped) {
      if (this.resetPending) this.doReset();
      let slice = Math.min(end - cpu.cycles, this.sched.nextTime() - cpu.cycles, cpu.cyclesToCompare(), 20000);
      if (slice < 1) slice = 1;
      const before = cpu.getCount();
      cpu.run(slice);
      const after = cpu.getCount();
      if (after !== before) {
        const cmp = cpu.cp0[11];
        if (((cmp - before) >>> 0) !== 0 && ((cmp - before) >>> 0) <= ((after - before) >>> 0)) cpu.timerIrq = true;
      }
      this.sched.runDue();
    }
  }
}
