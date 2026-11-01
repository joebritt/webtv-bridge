// NS16550-compatible UART, used for the LC2 hardware modem (Rockwell, behind the RIO bus at
// 0x1e000000 with a 4-byte register stride). The "line" side is pluggable: `this.onTx(byte)`
// receives transmitted bytes and `receive(byte)` injects received bytes.

export class Uart16550 {
  constructor({ onIrq, log } = {}) {
    this.onIrq = onIrq || (() => {});
    this.log = log || (() => {});
    this.onTx = () => {};
    this.reset();
  }

  reset() {
    this.ier = 0; this.lcr = 0; this.mcr = 0; this.lsrExtra = 0; this.msr = 0; this.scr = 0;
    this.dll = 1; this.dlm = 0; this.fcr = 0;
    this.rx = [];
    this.thrEmptyPending = false;
    this.irq = false;
    this.update();
  }

  get dlab() { return (this.lcr & 0x80) !== 0; }

  lsr() {
    let v = 0x60; // THRE | TEMT (transmit is instantaneous)
    if (this.rx.length) v |= 1;
    return v | this.lsrExtra;
  }

  iir() {
    if ((this.ier & 4) && this.lsrExtra) return 0x06 | (this.fcr & 1 ? 0xc0 : 0);
    if ((this.ier & 1) && this.rx.length) return 0x04 | (this.fcr & 1 ? 0xc0 : 0);
    if ((this.ier & 2) && this.thrEmptyPending) return 0x02 | (this.fcr & 1 ? 0xc0 : 0);
    if ((this.ier & 8) && (this.msr & 0x0f)) return 0x00 | (this.fcr & 1 ? 0xc0 : 0);
    return 0x01 | (this.fcr & 1 ? 0xc0 : 0);
  }

  update() {
    const pending = (this.iir() & 1) === 0;
    if (pending !== this.irq) { this.irq = pending; this.onIrq(pending); }
  }

  read(reg) {
    switch (reg) {
      case 0:
        if (this.dlab) return this.dll;
        { const v = this.rx.length ? this.rx.shift() : 0; this.update(); return v; }
      case 1: return this.dlab ? this.dlm : this.ier;
      case 2: {
        const v = this.iir();
        if ((v & 0x0f) === 0x02) { this.thrEmptyPending = false; this.update(); }
        return v;
      }
      case 3: return this.lcr;
      case 4: return this.mcr;
      case 5: { const v = this.lsr(); this.lsrExtra = 0; this.update(); return v; }
      case 6: { const v = this.msr; this.msr &= 0xf0; this.update(); return v; }
      case 7: return this.scr;
    }
    return 0;
  }

  write(reg, v) {
    v &= 0xff;
    switch (reg) {
      case 0:
        if (this.dlab) { this.dll = v; return; }
        this.onTx(v);
        this.thrEmptyPending = true;
        this.update();
        return;
      case 1:
        if (this.dlab) { this.dlm = v; return; }
        if ((v & 2) && !(this.ier & 2)) this.thrEmptyPending = true;
        this.ier = v & 0x0f; this.update(); return;
      case 2: this.fcr = v; if (v & 2) this.rx = []; this.update(); return;
      case 3: this.lcr = v; return;
      case 4: {
        const old = this.mcr; this.mcr = v;
        if (this.onMcr && old !== v) this.onMcr(v, old);
        return;
      }
      case 7: this.scr = v; return;
    }
  }

  receive(b) { this.rx.push(b & 0xff); this.update(); }

  setModemStatus(dcd, dsr, cts, ri) {
    const nv = (dcd ? 0x80 : 0) | (ri ? 0x40 : 0) | (dsr ? 0x20 : 0) | (cts ? 0x10 : 0);
    const delta = ((nv ^ this.msr) & 0x80 ? 8 : 0) | ((nv ^ this.msr) & 0x20 ? 2 : 0) | ((nv ^ this.msr) & 0x10 ? 1 : 0)
      | ((this.msr & 0x40) && !ri ? 4 : 0);
    this.msr = (this.msr & 0x0f) | delta | nv;
    this.update();
  }
}
