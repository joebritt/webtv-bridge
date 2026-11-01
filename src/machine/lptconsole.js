// Host side of the 1997 parallel-port debug console ("ECP IO"): what a debug build's
// Xfer2Bytes (InitECPCharIO / ECPCharIOOut / ECPCharIOIn) expects at the other end of the
// cable. The bridge runs this instead of PARMOD when its console mode is on
// (WEBTV_LPT_BRIDGE.md §3.7). Every console character is one swap, in software mode, with
// nStrobe from the box and nAck from the host:
//
//   host: 0xA5 on D0-D7, nAck low      = ready (nAck high: the box skips the swap at once)
//   box:  nStrobe low                  host releases D0-D7, nAck high
//   box:  drives its char, nStrobe high  host latches it, nAck low
//   box:  releases D0-D7, nStrobe low  host drives its char (bit 7 clear), nAck high
//   box:  reads it, nStrobe high       host drives 0xA5, nAck low (ready again)
//
// Each WaitAck on the box gives up after 1 s. A char with bit 7 set ends the swap early, so
// the host only sends 7-bit chars. The box sends NUL when it only wants input, and the host
// sends NUL when nobody has typed anything; both are dropped.
//
// The box keeps a char received during an output swap and returns it from the next input
// call, but a second output swap would overwrite it, so typed chars are only handed over in
// swaps where the box sent NUL (its input calls).

import { CTRL, STAT } from '../lptmodem/link.js';

const READY = 0, BOX_CHAR = 1, RELEASE = 2, HOST_CHAR = 3;

export class LptConsoleHost {
  constructor({ out = () => {} } = {}) {
    this.out = out;           // (byte) => void: a char from the box
    this.input = [];          // chars typed for the box
    this.stats = { fromBox: 0, toBox: 0, swaps: 0 };
    this.reset();
  }

  reset() {
    this.state = READY;
    this.ackLow = true;
    this.drive = 0xa5;
    this.boxChar = 0;
  }

  type(text) { for (const ch of text) this.input.push(ch.charCodeAt(0) & 0x7f); }

  get status() { return (this.ackLow ? 0 : STAT.ACK_N) | STAT.FAULT_N | STAT.SEL; }
  get data() { return this.drive; }

  // box changed its control lines or data pins; old/c are the CTRL values
  hostChanged(port, old, c) {
    const fell = (old & CTRL.STB_N) && !(c & CTRL.STB_N), rose = !(old & CTRL.STB_N) && (c & CTRL.STB_N);
    if (fell && this.state === READY) {
      this.drive = null; this.ackLow = false; this.state = BOX_CHAR;
    } else if (rose && this.state === BOX_CHAR) {
      this.boxChar = port.driving ? port.data : 0xff;
      this.ackLow = true; this.state = RELEASE;
    } else if (fell && this.state === RELEASE) {
      const b = this.boxChar === 0 && this.input.length ? this.input.shift() : 0;
      if (b) this.stats.toBox++;
      this.drive = b; this.ackLow = false; this.state = HOST_CHAR;
    } else if (rose) {
      // end of a swap (or the box gave up on one): ready for the next
      if (this.state === HOST_CHAR || this.state === RELEASE) {
        this.stats.swaps++;
        if (this.boxChar && this.boxChar !== 0xff) { this.stats.fromBox++; this.out(this.boxChar); }
      }
      this.reset();
    }
  }
}
