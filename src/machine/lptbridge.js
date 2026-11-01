// Emulated LPT↔WiFi bridge (WEBTV_LPT_BRIDGE.md): a parallel port peripheral that speaks PARMOD
// (src/machine/parmodhost.js, the bridge's half of src/lptmodem/parmod.js) and presents a Hayes
// modem on its modem channel. Dialing connects the modem's `line` (src/net/line.js: PPP server +
// TCP relay / built-in service), exactly as for the internal modem, so a patched OS build reaches
// the network through the parallel port.
//
//   const bridge = new LptBridge(machine);   // attaches to machine.solo.pport
//   bridge.modem.line = createNetworkLine({ ... });
//
// Until something else takes the port, the bridge waits, as the real one does, for a patched
// build's PARMOD entry (a strobe with nInit low carrying 'L') and then serves the session; its
// console channel goes to the log as [pmcon] lines. useParmod({ onConsole }) starts the session
// side at once with the console somewhere else (feed console input with pm.consoleIn + kick()).
//
// Other peripherals take the port with setConsole(host): the far end of an unpatched debug build's
// parallel debug console (src/machine/lptconsole.js), the diagnostics dongle (lptdiag.js), the
// stock-box loader's link (loaderLink). setConsole(null) gives it back.
//
// For the loader session (src/stockbox/session.js): onProbe() is called when the boot ROM's
// dongle probe shows on the lines (a reset), and onReboot() when the OS says it is about to reset
// itself.

import { Modem } from './modem.js';
import { ParmodHost } from './parmodhost.js';
import { CTRL, STAT } from '../lptmodem/link.js';
import { PMCMD } from '../lptmodem/parmod.js';

const BUF = 4096;

export class LptBridge {
  constructor(machine, { log = machine.log } = {}) {
    this.m = machine;
    this.log = log;
    this.port = null;
    this.trace = null; // optional (dir, byte) => void
    this.stats = { toBridge: 0, toBox: 0, resets: 0 };
    // host side of the modem: what the box sends arrives through onTx, `rx` is the queue
    // towards the box (the session's, while there is one)
    this.idleRx = [];
    const dte = {
      onTx: null, onMcr: null,
      rx: this.idleRx,
      receive: (b) => this.queue(b),
      setModemStatus: (dcd) => this.setCarrier(dcd),
    };
    this.dte = dte;
    this.dcd = false;
    this.modem = new Modem(machine, dte, { fifo: BUF, rate: 200000, burst: 64, name: 'lptmodem' });
    this.dtr = false;
    this.lastCtrl = CTRL.STB_N | CTRL.INIT_N | CTRL.AUTOFD_N | CTRL.SELIN_N;
    machine.solo.pport.attach(this);
  }

  attach(port) { this.port = port; this.lastCtrl = port.ctrl; this.hostChanged(); }

  // the session side of PARMOD, its modem channel this bridge's modem.
  // opts: { onConsole (default: the log), modemOut, onModemTaken, onCommand, onSession }
  useParmod({ onConsole = null, modemOut = null, onModemTaken = null, onCommand = null, onSession = null } = {}) {
    if (!onConsole) {
      let line = '';
      onConsole = (b) => { if (b === 10) { this.log(`[pmcon] ${line}`); line = ''; } else if (b !== 13) line += String.fromCharCode(b); };
    }
    const pm = new ParmodHost(this.m, {
      modemOut: modemOut || ((b) => {
        this.stats.toBridge++;
        if (this.trace) this.trace('>', b);
        if (this.dte.onTx) this.dte.onTx(b);
        return true;
      }),
      onModemTaken: onModemTaken || (() => { this.stats.toBox++; if (this.modem.out.length) this.modem.pump(); }),
      consoleOut: onConsole,
      onCommand: onCommand || ((c, arg) => this.parmodCommand(c, arg)),
      onSession,
    });
    this.pm = pm;
    this.dte.rx = pm.modemIn; // the modem paces itself against the link's queue
    this.setConsole(pm);
    return pm;
  }

  parmodCommand(c, arg) {
    if (c === PMCMD.MODEM_RESET) {
      this.stats.resets++;
      if (this.modem.online || this.modem.connected || this.modem.dialing) this.modem.hangup('link reset');
      this.modem.reset();
      this.pm.modemIn.length = 0;
    } else if (c === PMCMD.DTR_ON || c === PMCMD.DTR_OFF) {
      const dtr = c === PMCMD.DTR_ON, was = this.dtr;
      if (dtr === was) return;
      this.dtr = dtr;
      if (this.dte.onMcr) this.dte.onMcr(dtr ? 1 : 0, was ? 1 : 0);
    } else if (c === PMCMD.REBOOT) {
      this.log('[lpt] the OS says it is rebooting');
      if (this.onReboot) this.onReboot();
    } else if (c === PMCMD.LEGACY_ECP) {
      this.log(`[lpt] LEGACY_ECP request 0x${arg.toString(16)}: no 1997 ECP host in the emulator; staying in the session`);
    }
  }

  // the stock-box loader's link (src/stockbox/loader.js): PARMOD, its protocol on the modem
  // channel. -> { send(bytes), pending (bytes not yet taken by the box) }. setConsole(null) ends it.
  loaderLink(onByte) {
    const pm = new ParmodHost(this.m, { modemOut: (b) => { onByte(b); return true; } });
    this.setConsole(pm);
    return {
      send: (bytes) => { for (const b of bytes) pm.modemIn.push(b); pm.kick(); },
      get pending() { return pm.modemIn.length; },
    };
  }

  dropParmod() {
    if (!this.pm) return;
    this.pm = null;
    this.dte.rx = this.idleRx;
  }

  setConsole(host) {
    if (host !== this.pm) this.dropParmod();
    this.console = host;
    if (host) host.reset();
    if (this.port) { this.lastCtrl = this.port.ctrl; this.port.update(); }
  }

  // nothing on the port: the lines as an idle bridge leaves them
  get status() {
    if (this.console) return this.console.status;
    return STAT.ACK_N | STAT.FAULT_N | STAT.SEL;
  }

  get data() { return this.console ? this.console.data : null; }

  // box -> bridge: one of the control lines (or the data pins) changed
  hostChanged() {
    const p = this.port;
    if (!p) return;
    const c = p.ctrl, old = this.lastCtrl;
    this.lastCtrl = c;
    // The boot ROM's dongle probe after a reset: the four control lines high (nothing PARMOD
    // ever strobes with), the box driving one of D0-D3 and D4-D7 high. onProbe() may put the
    // dongle (a diagnostics host) on the port at once, in time for the ROM's STAT read.
    if (this.onProbe && (c & 0x0f) === 0x0f && p.driving && [0xf1, 0xf2, 0xf4, 0xf8].includes(p.data)) {
      const f = this.onProbe; this.onProbe = null;
      f();
    }
    if (!this.console && !(c & CTRL.INIT_N) && (old & CTRL.STB_N) && !(c & CTRL.STB_N) && p.driving && p.data === 0x4c) {
      this.log('[lpt] PARMOD entry seen: the bridge serves the session');
      this.useParmod();
    }
    if (this.console) this.console.hostChanged(p, old, c);
    p.update();
  }

  // modem -> box (dropped while no session is up)
  queue(b) {
    if (this.pm) { this.pm.modemIn.push(b); this.pm.kick(); }
  }

  setCarrier(dcd) {
    if (dcd === this.dcd) return;
    this.dcd = dcd;
    if (this.pm) this.pm.setCarrier(dcd);
  }

  // FIFO-mode writes (an unpatched debug build's ECP console, a printer driver): log text
  fifoWrite(b) {
    if (b === 10) { if (this.fifoLine) this.log(`[lpt] ${this.fifoLine}`); this.fifoLine = ''; return; }
    if (b >= 32 && b < 127) this.fifoLine = (this.fifoLine || '') + String.fromCharCode(b);
  }

  reset() {
    this.modem.hangup();
    this.modem.reset();
    this.dtr = false;
    if (this.console) this.console.reset();
  }
}
