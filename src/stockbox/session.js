// The bridge's side of the boot ROM's diagnostics, in the emulator: what the Pico firmware
// will do (WEBTV_LPT_BRIDGE.md §10.6), on the emulated bridge.
//
//   1. play the loopback dongle; at any reset the boot ROM sees it and enters its diagnostics,
//      console on the port (src/machine/lptdiag.js)
//   2. at `Parallel in>`: `18` (EnterDebugger) -> the debug monitor's `app>` prompt
//   3. `sl a4009088 108080`: the video's blank colour to black (the diagnostics set it magenta)
//   4. `dr a8`: BUS_RESETCAUSE says why the box reset (0 or 1 power applied; 2 watchdog; 4
//      software; 7 the OS's and the ROM's own reboots, power-off from the remote among them).
//      decide(cause) picks what happens next:
//      'handback'  `sl` the zap routine (loader.js buildZap: clear RAM, then the ROM's own
//                  reset), `epc`, `g`; the bridge stops mirroring as soon as the `g` line's CR
//                  has gone out, so the next check fails and the box boots as from cold
//      'install'   `sl` stage 0 into RAM a line at a time, `epc`, `g`; at the end of the `g`
//                  line release D7 and switch the port to PARMOD; send the loader over it
//                  (protocol.js stage0Image); stage 0 answers LOADED and jumps to it
//
// A boot ROM without the debug monitor (a production ROM: its banner says "non-debug") takes
// the other way in (WEBTV_LPT_BRIDGE.md §10.7): test 19 boots the tier-3 image on the disk
// (tier3.js), which is the loader; the session then sends HELLO over PARMOD until it answers
// ('loader'), or gives up after tier3Secs ('no-tier3': the box boots its own OS, unpatched).
// No reset cause on that way (no `dr`).
//
// The emulator skips Debugger() breaks by default; the session turns that off, as test 18
// needs the monitor.
//
//   const s = new StockboxSession(machine, { log, decide });
//   s.start();                      // then run the machine; s.phase ends 'loader' or 'handedback'
//   s.send(enc.hello());            // s.messages collects the loader's replies (protocol.js);
//                                   // its IR runs are decoded into s.keys (irdecode.js)

import { LptDiagHost } from '../machine/lptdiag.js';
import { buildLoader, buildStage0, buildZap } from './loader.js';
import { MessageParser, stage0Image, CMD } from './protocol.js';
import { IrKeys } from './irdecode.js';

const WORDS_PER_LINE = 32;

// `sl` lines that put an image in RAM
function slLines(img) {
  const lines = [];
  for (let o = 0; o < img.bytes.length; o += WORDS_PER_LINE * 4) {
    const ws = [];
    for (let i = o; i < Math.min(img.bytes.length, o + WORDS_PER_LINE * 4); i += 4) {
      ws.push((((img.bytes[i] << 24) | (img.bytes[i + 1] << 16) | (img.bytes[i + 2] << 8) | img.bytes[i + 3]) >>> 0).toString(16));
    }
    lines.push(`sl ${(img.base + o).toString(16)} ${ws.join(' ')}\r`);
  }
  return lines;
}

export class StockboxSession {
  constructor(machine, { log = () => {}, decide = () => 'install', loader = buildLoader(), stage0 = buildStage0(), zap = buildZap(), tier3Secs = 10 } = {}) {
    this.m = machine;
    this.tier3Secs = tier3Secs;
    this.debugRom = true;     // until the banner says otherwise
    this.log = log;
    this.decide = decide;
    this.loader = loader;
    this.stage0 = stage0;
    this.zap = zap;
    // the loader's variables come after its code and font, and it sets them itself
    this.image = stage0Image(loader.bytes.subarray(0, loader.labels.get('V_SCALE') - loader.base));
    this.lines = slLines(stage0);
    this.zapLines = slLines(zap);
    this.uploadWords = stage0.size / 4;
    this.phase = 'idle';
    this.line = '';
    this.cause = null;
    this.messages = [];       // replies: hello, sync, err, junk
    this.keys = [];           // decoded key presses: { key, source }
    this.irRuns = 0;
    this.onPhase = null;      // (phase) => void
    this.onKey = null;        // (key, { source, code }) => void
    this.onMessage = null;    // (msg) => true if it took it (BoxMem's replies)
    this.ir = new IrKeys((key, info) => { this.keys.push({ key, ...info }); if (this.onKey) this.onKey(key, info); },
      () => machine.cpu.cycles / machine.cpuHz * 1e6);   // emulated time stands in for the Pico's clock
    this.parser = new MessageParser((msg) => {
      if (msg.type === 'ir') { this.irRuns += msg.entries.length; for (const e of msg.entries) this.ir.entry(e); }
      else if (msg.type === 'loaded') this.setPhase('loader');
      else if (msg.type === 'hello' && this.phase === 'tier3') this.setPhase('loader');
      else if (msg.type === 'badsum') { this.log('[stockbox] stage 0: bad sum, sending the loader again'); this.send(this.image); }
      else if (!(this.onMessage && this.onMessage(msg))) this.messages.push(msg);
    });
  }

  // start mirroring: from now on any reset of the box lands in the diagnostics
  start() {
    this.m.skipDebugger = false;
    this.diag = new LptDiagHost(this.m, { out: (c) => this.char(c) });
    this.m.lptBridge.setConsole(this.diag);
    this.setPhase('mirroring');
  }

  setPhase(p) {
    this.phase = p;
    this.log(`[stockbox] ${p}`);
    if (this.onPhase) this.onPhase(p);
  }

  char(c) {
    if (c === 10) {
      if (this.line) this.log(`[diag] ${this.line}`);
      if (this.phase === 'cause') {
        const m = this.line.match(/^0xa40000a8: 0x([0-9a-f]+)/);
        if (m) this.cause = parseInt(m[1], 16);
      }
      this.line = '';
      if (this.phase === 'go') this.toLoader();
      return;
    }
    if (c !== 13) this.line += String.fromCharCode(c);
    const at = (p) => this.line.endsWith(p);
    if (at('non-debug')) this.debugRom = false;
    switch (this.phase) {
      case 'mirroring':
        if (!at('Parallel in>')) break;
        if (this.debugRom) { this.diag.type('18\r'); this.setPhase('debugger'); }
        else { this.diag.type('19\r'); this.setPhase('tier3-boot'); }
        break;
      case 'tier3-boot':
        if (at('Now booting to Tier 3')) this.toTier3();
        break;
      case 'debugger':
        // the diagnostics leave the TV magenta (the video's blank colour) until the loader runs:
        // black, first thing
        if (at('app>')) { this.diag.type('sl a4009088 108080\r'); this.setPhase('black'); }
        break;
      case 'black':
        if (at('app>')) { this.diag.type('dr a8\r'); this.setPhase('cause'); }
        break;
      case 'cause':
        if (at('app>')) {
          const what = this.decide(this.cause);
          this.log(`[stockbox] reset cause ${this.cause} (${this.cause & 4 ? 'software' : this.cause & 2 ? 'watchdog' : 'power applied'}): ${what}`);
          this.target = what === 'handback' ? this.zap : this.stage0;
          this.targetLines = what === 'handback' ? this.zapLines : this.lines;
          this.next = 0;
          this.setPhase(what === 'handback' ? 'handback' : 'upload');
          this.upload();
        }
        break;
      case 'upload': case 'handback':
        if (at('app>')) this.upload();
        break;
      case 'epc': case 'handback-epc':
        if (!at('app>')) break;
        this.diag.type('g\r');
        if (this.phase === 'epc') this.setPhase('go');
        else this.handBack();
        break;
    }
  }

  upload() {
    if (this.next < this.targetLines.length) {
      this.diag.type(this.targetLines[this.next++]);
      return;
    }
    this.diag.type(`epc ${this.target.base.toString(16)}\r`);
    this.setPhase(this.phase === 'handback' ? 'handback-epc' : 'epc');
  }

  // `g` is on its way to the zap routine: stop mirroring once its CR is out
  handBack() {
    this.setPhase('handback-go');
    const wait = () => {
      if (this.diag.input.length || this.diag.txBusy) { this.m.sched.after('stockbox-handback', 1000, wait); return; }
      this.release();
      this.setPhase('handedback');
    };
    wait();
  }

  // stop being the dongle (or the loader's link): idle lines, which fail the check
  release() {
    if (this.diag) this.diag.stop();
    this.m.lptBridge.setConsole(null);
  }

  // test 19 is booting the tier-3 image: the diagnostics are done with the port. HELLO until the
  // loader answers.
  toTier3() {
    this.release();
    this.link = this.m.lptBridge.loaderLink((b) => this.parser.feed(b));
    this.setPhase('tier3');
    const until = this.m.cpu.cycles + this.tier3Secs * this.m.cpuHz;
    const hello = () => {
      if (this.phase !== 'tier3') return;
      if (this.m.cpu.cycles > until) { this.release(); this.setPhase('no-tier3'); return; }
      if (!this.link.pending) this.send([CMD.HELLO]);   // one at a time
      this.m.sched.after('stockbox-hello', Math.round(this.m.cpuHz / 5), hello);
    };
    this.m.sched.after('stockbox-hello', Math.round(this.m.cpuHz / 2), hello);
  }

  toLoader() {
    this.release();
    this.link = this.m.lptBridge.loaderLink((b) => this.parser.feed(b));
    this.setPhase('stage0');
    this.send(this.image);
  }

  // to the loader (or stage 0), on PARMOD's modem channel
  send(bytes) { this.link.send(bytes); }
}
