// Rockwell-style Hayes modem on the line side of the LC2 hardware-modem UART.
//
// - Command mode: AT commands, echo, result codes.
// - AT** puts the modem in firmware-download mode (used by the WebTV "TellyScript" Rockwell
//   modem downloader); downloaded firmware is acknowledged and discarded.
// - ATD dials; the connection is delegated to a pluggable `line` object
//   ({ connect(number) -> Promise<boolean>, send(byte), close(), onData(byte), onClose() }).
//   Without a line, dialing returns NO DIALTONE. Online data towards the host is paced through
//   the same queue as result codes (~11.5k bytes/s, holding off while the UART FIFO is full).
//   src/net/line.js provides the network line (PPP server + TCP relay).

const CR = 13, LF = 10;

const DL_QUIET_S = 0.05;   // how long the box must be quiet before an image's end is answered

export class Modem {
  // `uart` is the host side: { onTx, onMcr, rx (queue towards the host), receive(byte),
  // setModemStatus(dcd, dsr, cts, ri) }. opts: { fifo: host queue depth to fill before
  // holding off, rate: bytes/s towards the host, burst: bytes per delivery tick, name: prefix
  // for scheduler events }.
  constructor(machine, uart, { fifo = 16, rate = 11520, burst = 1, name = 'modem' } = {}) {
    this.m = machine;
    this.uart = uart;
    this.fifo = fifo; this.rate = rate; this.burst = burst;
    this.ev = (what) => `${name}-${what}`; // scheduler event names
    this.log = machine.log;
    this.line = null;
    this.trace = null; // optional (dir, byte) => void
    uart.onTx = (b) => this.fromHost(b);
    uart.onMcr = (v, old) => { if ((old & 1) && !(v & 1) && (this.online || this.connected || this.dialing)) this.hangup('DTR drop'); };
    this.reset();
  }

  reset() {
    this.cmd = '';
    this.echo = true;
    this.verbose = true;
    this.quiet = false;
    this.online = false;
    this.connected = false;
    this.dialing = false;
    this.download = false;
    this.downloadCount = 0;
    this.out = [];
    // the delivery event may be gone (a box reset clears the scheduler): a stale `pumping`
    // would stop the modem from ever delivering again
    this.pumping = false;
    this.m.sched.cancel(this.ev('out'));
    this.plusCount = 0;
    this.lastTxCycle = 0;
    this.sregs = new Uint8Array(256);
    this.sregs[2] = 43; this.sregs[3] = 13; this.sregs[4] = 10; this.sregs[5] = 8; this.sregs[12] = 50;
    this.uart.setModemStatus(false, true, true, false);
  }

  // ------------------------------------------------------------------ host -> modem

  fromHost(b) {
    if (this.trace) this.trace('>', b);
    if (this.online) {
      this.lastTxCycle = this.m.cpu.cycles;
      if (b === this.sregs[2]) { if (++this.plusCount === 3) this.m.sched.after(this.ev('esc'), this.m.cpuHz, () => this.escape()); }
      else this.plusCount = 0;
      if (this.line) this.line.send(b);
      return;
    }
    if (this.download) { this.downloadByte(b); return; }
    if (this.echo) this.queue([b]);
    if (b === this.sregs[5]) { this.cmd = this.cmd.slice(0, -1); return; }
    if (b === CR) {
      const line = this.cmd.trim();
      this.cmd = '';
      const u = line.toUpperCase();
      const at = u.lastIndexOf('AT');
      if (at >= 0) this.command(u.slice(at + 2));
      return;
    }
    if (b === LF) return;
    this.cmd += String.fromCharCode(b);
    if (this.cmd.length > 256) this.cmd = this.cmd.slice(-256);
  }

  escape() {
    if (this.online && this.plusCount === 3 && this.m.cpu.cycles - this.lastTxCycle >= this.m.cpuHz * 0.9) {
      this.online = false;
      this.result('OK');
    }
    this.plusCount = 0;
  }

  // ------------------------------------------------------------------ firmware download

  // TellyScript protocol (modem_downloader.tok): AT** -> modem answers with two LFs; host
  // sends an S-record SRAM loader (or, on warm boots, a tiny "NULL loader" and nothing
  // else). The real loader then prints its banner and "Download Modem Firmware .."; the host
  // sends the firmware and waits for "Modem Firmware Successfully Loaded". The loader ends
  // with an S7/S8/S9 termination record. The firmware may come as S-records too, or (16423's
  // "Binary Ram Loader" on a cold boot) as raw binary, which ends when the host goes quiet.
  // The box's sender (SI_modem_blastdata) checks after each byte it writes whether one has come
  // back, and anything but '.' fails the download (TellyScript returns 0x11, the OS reboots).
  // So the end of an S-record image is answered only once the box has gone quiet (DL_QUIET_S):
  // the image ends with CR LF, and an answer on the CR could beat the LF.
  downloadByte(b) {
    this.downloadCount++;
    if (this.m.sched.pending(this.ev('dl-end'))) this.armDlEnd();
    if (this.download === 2) {
      if (!this.dlData && (b === CR || b === LF)) { this.downloadCount--; return; } // the loader's last line end
      this.dlData = true;
      this.m.sched.after(this.ev('dl-idle'), Math.round(this.m.cpuHz * 0.2), () => this.downloadImageDone());
    }
    if (b === LF || b === CR) {
      const rec = this.dlLine; this.dlLine = '';
      if (/^S[789]/.test(rec)) this.armDlEnd();
      return;
    }
    this.dlLine = (this.dlLine || '') + String.fromCharCode(b);
    if (this.dlLine.length > 600) this.dlLine = '';
  }

  armDlEnd() {
    this.m.sched.cancel(this.ev('dl-end'));
    this.m.sched.after(this.ev('dl-end'), Math.round(this.m.cpuHz * DL_QUIET_S), () => this.downloadImageDone());
  }

  downloadImageDone() {
    if (!this.download) return;
    this.m.sched.cancel(this.ev('dl-idle'));
    this.m.sched.cancel(this.ev('dl-end'));
    this.log(`[modem] download phase ${this.download}: ${this.downloadCount} bytes`);
    const small = this.downloadCount < 512;
    this.downloadCount = 0;
    if (this.download === 1 && small) { this.download = false; return; } // NULL loader: back to command mode
    if (this.download === 1) { this.download = 2; this.dlData = false; this.queueStr('\r\nBinary Ram Loader - V0.08\r\nDownload Modem Firmware ..\r\n'); return; }
    this.download = false;
    this.queueStr('Modem Firmware Successfully Loaded\r\n');
  }

  // ------------------------------------------------------------------ AT commands

  command(s) {
    this.log(`[modem] AT${s}`);
    if (s.startsWith('**')) {
      this.download = 1;
      this.downloadCount = 0;
      this.dlLine = '';
      this.queueStr('\r\nOK\r\n');
      return;
    }
    let i = 0;
    const num = () => { let n = ''; while (i < s.length && s[i] >= '0' && s[i] <= '9') n += s[i++]; return n === '' ? 0 : Number(n); };
    while (i < s.length) {
      const c = s[i++];
      switch (c) {
        case ' ': break;
        case 'D': {
          // The WebTV TellyScript dials "ATDT<number>;" (dial, stay in command mode -> OK), then
          // sends a bare "ATD" to go off-hook in originate mode and wait for the carrier.
          const rest = s.slice(i);
          this.dial(rest.replace(/[^0-9*#,WP]/g, ''), rest.includes(';'));
          return;
        }
        case 'A': this.result('NO CARRIER'); return;
        case 'H': num(); if (this.line && this.online) this.hangup(); break;
        case 'O': num(); if (this.line && this.connected) { this.online = true; this.result('CONNECT'); return; } this.result('NO CARRIER'); return;
        case 'Z': num(); this.echo = true; this.verbose = true; this.quiet = false; break;
        case 'E': this.echo = num() !== 0; break;
        case 'V': this.verbose = num() !== 0; break;
        case 'Q': this.quiet = num() !== 0; break;
        case 'S': {
          const r = num();
          if (s[i] === '=') { i++; this.sregs[r & 255] = num(); }
          else if (s[i] === '?') { i++; this.queueStr(`\r\n${String(this.sregs[r & 255]).padStart(3, '0')}\r\n`); }
          break;
        }
        case 'I': { const n = num(); this.queueStr(`\r\n${n === 0 ? '56000' : 'WebTV emulated modem'}\r\n`); break; }
        case '&': case '%': case '\\': case '+': case '-': case '#': case '*': case '$':
          // extended commands: skip letter + number (+ optional =value list)
          i++; num();
          if (s[i] === '=') { i++; while (i < s.length && /[0-9,]/.test(s[i])) i++; }
          break;
        default:
          // B, C, L, M, N, P, T, W, X, Y and friends: accept with optional number
          num();
      }
    }
    this.result('OK');
  }

  dial(number, stay) {
    this.log(`[modem] dialing ${number || '(none)'}${stay ? ' (stay in command mode)' : ''}`);
    if (!this.line) {
      this.m.sched.after(this.ev('dial'), Math.floor(this.m.cpuHz * 2), () => this.result('NO DIALTONE'));
      return;
    }
    if (stay) {
      this.dialedNumber = number;
      this.m.sched.after(this.ev('dial'), Math.floor(this.m.cpuHz * 1), () => this.result('OK'));
      return;
    }
    if (!number && this.dialedNumber) number = this.dialedNumber;
    this.dialedNumber = null;
    this.uart.setModemStatus(false, true, true, false);
    const line = this.line;
    this.dialing = true;
    // the line answers asynchronously; report CONNECT after a short (emulated) handshake delay
    const t0 = this.m.cpu.cycles;
    Promise.resolve(line.connect(number)).catch(() => false).then((ok) => {
      if (!this.dialing || this.line !== line) return;
      const wait = Math.max(0, Math.floor(this.m.cpuHz * 1.5) - (this.m.cpu.cycles - t0));
      this.m.sched.after(this.ev('dial'), wait, () => {
        if (!this.dialing) return;
        this.dialing = false;
        if (!ok) { this.result('NO CARRIER'); return; }
        this.connected = true;
        line.onData = (b) => { if (this.online) { this.out.push(b); this.pump(); } };
        line.onClose = () => this.hangup('remote');
        line.backlog = () => this.out.length;
        this.uart.setModemStatus(true, true, true, false);
        this.result('CONNECT 57600');
        this.online = true;
      });
    });
  }

  hangup(why) {
    if (why) this.log(`[modem] hangup (${why})`);
    const wasOnline = this.online || this.connected;
    this.online = false; this.connected = false; this.dialing = false; this.dialedNumber = null;
    this.out.length = 0;
    this.m.sched.cancel(this.ev('dial'));
    if (this.line) { this.line.onData = null; this.line.onClose = null; this.line.close(); }
    this.uart.setModemStatus(false, true, true, false);
    if (wasOnline && why) this.result('NO CARRIER');
  }

  // ------------------------------------------------------------------ modem -> host

  result(text) {
    if (this.quiet) return;
    if (this.verbose) this.queueStr(`\r\n${text}\r\n`);
    else {
      // Rockwell numeric result codes (CONNECT <DTE rate> with X4)
      const codes = { OK: 0, CONNECT: 1, RING: 2, 'NO CARRIER': 3, ERROR: 4, 'NO DIALTONE': 6, BUSY: 7, 'NO ANSWER': 8,
        'CONNECT 2400': 10, 'CONNECT 4800': 11, 'CONNECT 9600': 12, 'CONNECT 19200': 16, 'CONNECT 38400': 17,
        'CONNECT 57600': 18, 'CONNECT 115200': 19, 'CONNECT 230400': 20 };
      this.queueStr(`${codes[text] ?? codes[text.split(' ')[0]] ?? 1}\r`);
    }
  }

  queueStr(s) { this.queue(Array.from(s, (ch) => ch.charCodeAt(0))); }

  queue(bytes) {
    for (const b of bytes) this.out.push(b);
    this.pump();
  }

  // Deliver queued bytes to the host at roughly line speed (~11.5k bytes/s for the UART)
  pump() {
    if (this.pumping || !this.out.length) return;
    this.pumping = true;
    this.m.sched.after(this.ev('out'), Math.floor(this.m.cpuHz * this.burst / this.rate), () => {
      this.pumping = false;
      for (let n = 0; n < this.burst && this.uart.rx.length < this.fifo && this.out.length; n++) {
        const b = this.out.shift();
        if (this.trace) this.trace('<', b);
        this.uart.receive(b);
      }
      this.pump();
    });
  }
}
