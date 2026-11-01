// Host side of the LC2 boot ROM's factory diagnostics console: what the bridge runs to set
// up a stock box (WEBTV_LPT_BRIDGE.md, "Setting up an unmodified box"). Two jobs at once:
//
// Loopback dongle. At cold boot the ROM drives D0-D3 one at a time and looks for a fixed
// pattern on the status lines (src/machine/lptdongle.js). Seeing it, the ROM skips the OS and
// enters "LC2 Tier2 Diagnostics", with its console on the parallel port. The status lines
// here always follow the data pins, whoever drives them, as a real loopback plug would.
//
// Console. A bit-banged 19200 8N1 serial line, LSB first, idle high:
//
//   box -> host  nSelectIn (CTRL bit 3), char out at 0x80226170 in boot ROM 3475
//   host -> box  D7, with the box's data pins turned around (DIR in), char in at 0x80226244
//
// The box only listens while it sits in char in: it polls D7 for a start bit for 1 ms, then
// returns 0 and the caller polls again. While it sends (an echo, a prompt) it does not
// listen, and every char out starts with 520 us of idle line. So the host never sends while
// the box may be about to talk: before each char it waits until neither line has moved for
// `quiet` us, long enough for an echo of the last char to have started.
//
// Timing runs on the machine's scheduler in CPU cycles. The box times its bits from CP0
// Count (52 us a bit, 0.2% fast), the host at a true 19200 baud, as a real UART would.

const SELIN_N = 0x08;
const BAUD = 19200;

export class LptDiagHost {
  constructor(machine, { out = () => {}, baud = BAUD, quiet = 1500 } = {}) {
    this.m = machine;
    this.out = out;           // (byte) => void: a char from the box
    this.input = [];          // chars to send to the box
    this.bit = machine.cpuHz / baud;
    this.quietCycles = machine.cpuHz * quiet / 1e6;
    this.stats = { fromBox: 0, toBox: 0, framing: 0 };
    this.port = null;
    this.reset();
  }

  reset() {
    this.d7 = 1;              // our TX line (D7), idle high
    this.rxBusy = false;
    this.txBusy = false;
    this.lastBoxActivity = this.m.cpu.cycles;
    this.m.sched.cancel('lptdiag-rx');
    this.m.sched.cancel('lptdiag-tx');
    this.kick();
  }

  // hand the port to something else: no more bits either way, D7 released
  stop() {
    this.input.length = 0;
    this.m.sched.cancel('lptdiag-rx');
    this.m.sched.cancel('lptdiag-tx');
    this.rxBusy = this.txBusy = false;
    this.d7 = 1;
  }

  type(text) {
    for (const ch of text) this.input.push(ch.charCodeAt(0) & 0xff);
    this.kick();
  }

  // the data pins as they are on the cable: the box's when it drives them, else ours
  get pins() {
    const p = this.port;
    if (p && p.driving) return p.data;
    return this.d7 ? 0x80 : 0;
  }

  get status() {
    const d = this.pins;
    return (d & 1 ? 0x02 : 0) | (d & 2 ? 0x01 : 0) | (d & 4 ? 0x10 : 0) | (d & 8 ? 0x0c : 0);
  }

  get data() { return this.d7 ? 0x80 : 0; }

  hostChanged(port, old, c) {
    this.port = port;
    if (old === undefined) return;
    const fell = (old & SELIN_N) && !(c & SELIN_N);
    if ((old ^ c) & SELIN_N) this.lastBoxActivity = this.m.cpu.cycles;
    if (fell && !this.rxBusy) this.startRx();
  }

  // ---- box -> host: sample mid-bit, as a UART does
  startRx() {
    this.rxBusy = true;
    let n = 0, byte = 0;
    const t0 = this.m.cpu.cycles;
    const level = () => (this.port.ctrl & SELIN_N ? 1 : 0);
    const sample = () => {
      const v = level();
      if (n === 0 && v) { this.rxBusy = false; return; }          // glitch, not a start bit
      if (n >= 1 && n <= 8) byte |= v << (n - 1);
      if (n === 9) {
        this.rxBusy = false;
        this.lastBoxActivity = this.m.cpu.cycles;
        if (!v) { this.stats.framing++; return; }
        this.stats.fromBox++;
        this.out(byte);
        this.kick();
        return;
      }
      n++;
      this.m.sched.at('lptdiag-rx', Math.round(t0 + (n + 0.5) * this.bit), sample);
    };
    this.m.sched.at('lptdiag-rx', Math.round(t0 + 0.5 * this.bit), sample);
  }

  // ---- host -> box
  kick() {
    if (this.txBusy || !this.input.length) return;
    const now = this.m.cpu.cycles;
    const ready = Math.max(this.lastBoxActivity, this.txEnd ?? 0) + this.quietCycles;
    if (this.rxBusy || now < ready) {
      this.m.sched.at('lptdiag-tx', Math.round(Math.max(ready, now + this.bit)), () => this.kick());
      return;
    }
    const b = this.input.shift();
    this.txBusy = true;
    const t0 = now;
    let n = 0;
    const edge = () => {
      // start bit, 8 data bits LSB first, stop bit
      this.d7 = n === 0 ? 0 : n <= 8 ? (b >> (n - 1)) & 1 : 1;
      if (this.port) this.port.update();
      if (n === 9) {
        this.txBusy = false;
        this.stats.toBox++;
        this.txEnd = Math.round(t0 + 10 * this.bit);
        this.m.sched.at('lptdiag-tx', this.txEnd, () => this.kick());
        return;
      }
      n++;
      this.m.sched.at('lptdiag-tx', Math.round(t0 + n * this.bit), edge);
    };
    edge();
  }
}
