// SOLO1 parallel port (devUnit + 0x200, registers in src/lptmodem/link.js).
//
// Software mode (CNFG = 0) is modelled at the pin level: CTRL drives nStrobe, nAutoFd,
// nInit, nSelectIn and the data direction, DATA reads/writes the data pins, STAT samples
// the peripheral's lines and a low->high edge on nAck sets IST.ACKDONE. That is all the LPT
// modem link needs. In the FIFO modes (compatibility, ECP) forward bytes are handed to the
// peripheral at once and the FIFO always reads as empty; ECP reverse transfers are not
// modelled.
//
// A peripheral is { attach(port), hostChanged(), status (STAT bits), data (byte it drives,
// or null) }; it calls port.update() after changing its lines. With nothing attached the
// box's pull-ups make every status line read high.

import { PP, CTRL, STAT, INT } from '../lptmodem/link.js';

export class SoloPport {
  constructor({ onIrq = () => {}, log = () => {} } = {}) {
    this.onIrq = onIrq;
    this.log = log;
    this.peripheral = null;
    this.reset();
  }

  reset() {
    this.data = 0;
    this.ctrl = CTRL.STB_N | CTRL.INIT_N | CTRL.AUTOFD_N | CTRL.SELIN_N;
    this.cnfg = 0; this.fifoCtrl = 0; this.ien = 0; this.ist = 0; this.enable = 0;
    this.lastStat = this.status();
    this.irq = false;
    this.updateIrq();
    if (this.peripheral) this.peripheral.hostChanged();
  }

  attach(p) {
    this.peripheral = p;
    if (p) p.attach(this);
    this.lastStat = this.status();
  }

  status() {
    const all = STAT.BUSY | STAT.ACK_N | STAT.FAULT_N | STAT.SEL | STAT.PE;
    return this.peripheral ? this.peripheral.status & all : all;
  }

  // the levels the box drives
  get driving() { return !!(this.ctrl & CTRL.DIR_OUT); }

  // peripheral -> port: its lines changed
  update() {
    const s = this.status();
    if (this.cnfg === 0 && !(this.lastStat & STAT.ACK_N) && (s & STAT.ACK_N)) this.ist |= INT.ACKDONE;
    this.lastStat = s;
    this.updateIrq();
  }

  updateIrq() {
    const irq = !!(this.enable & 1) && (this.ist & this.ien) !== 0;
    if (irq !== this.irq) { this.irq = irq; this.onIrq(irq); }
  }

  read(o) {
    switch (o) {
      case PP.DATA: {
        if (this.driving) return this.data;
        const d = this.peripheral ? this.peripheral.data : null;
        return d == null ? 0xff : d & 0xff;
      }
      case PP.CTRL: return this.ctrl;
      case PP.STAT: return this.status();
      case PP.CNFG: return this.cnfg;
      case PP.FIFOCTRL: return this.fifoCtrl;
      case PP.FIFOSTAT: return 0; // FIFO empty, no termination in progress
      case PP.STAT2: return this.ctrl & 0x0f;
      case PP.IEN: return this.ien;
      case PP.IST: return this.ist;
      case PP.ENABLE: return this.enable;
    }
    return 0;
  }

  write(o, v) {
    switch (o) {
      case PP.DATA:
        this.data = v & 0xff;
        if (this.cnfg !== 0) {
          if (this.peripheral && this.peripheral.fifoWrite) this.peripheral.fifoWrite(this.data, !!(this.ctrl & CTRL.ECPCMND));
        } else if (this.driving && this.peripheral) this.peripheral.hostChanged();
        return;
      case PP.CTRL: {
        const old = this.ctrl;
        this.ctrl = v & 0x3f;
        if (old !== this.ctrl && this.peripheral) this.peripheral.hostChanged();
        return;
      }
      case PP.CNFG: this.cnfg = v & 3; return;
      case PP.FIFOCTRL: this.fifoCtrl = v & 0x1f; return;
      case PP.IEN: this.ien = v & 0x1f; this.updateIrq(); return;
      case PP.CLRINT: this.ist &= ~v; this.updateIrq(); return;
      case PP.ENABLE: this.enable = v & 1; this.updateIrq(); return;
    }
  }
}
