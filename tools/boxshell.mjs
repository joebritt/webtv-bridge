#!/usr/bin/env node
// The bridge's box shell (src/stockbox/shell.js) on an emulated stock box: the bridge takes
// the box through its diagnostics into the loader (src/stockbox/session.js), then reads,
// writes and calls through the loader.
//
//   node tools/boxshell.mjs --script 'dsl a40000a8; dm 80400000 40'   run commands, then exit
//   node tools/boxshell.mjs --listen 2323                            then: nc 127.0.0.1 2323
//
//   [--rom FILE]  boot ROM (default data/flipped_merged_boot.bin)
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { WebTV } from '../src/machine/webtv.js';
import { StockboxSession } from '../src/stockbox/session.js';
import { BoxMem } from '../src/stockbox/boxmem.js';
import { BoxShell } from '../src/stockbox/shell.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const m = new WebTV({ rom: readFileSync(opt('rom', 'data/flipped_merged_boot.bin')), disk: null, log: () => {} });
const s = new StockboxSession(m, { log: (l) => { if (/loader|cause/.test(l) && !l.startsWith('[diag]')) console.error(l); } });
s.start();
while (s.phase !== 'loader') {
  if (m.cpu.cycles > 30 * m.cpuHz) throw new Error('the loader never started');
  m.run(5e6);
}
console.error(`[boxshell] loader running at ${(m.cpu.cycles / m.cpuHz).toFixed(1)} s (emulated)`);
const mem = new BoxMem(s);

if (opt('script')) {
  const sh = new BoxShell(mem, { out: (t) => process.stdout.write(t) });
  for (const l of opt('script').split(';')) sh.line(l);
  sh.start();
  while (sh.busy) m.run(1e6);
  process.stdout.write('\n');
} else {
  const port = Number(opt('listen', 2323));
  createServer((sock) => {
    const sh = new BoxShell(mem, { out: (t) => sock.write(t.replace(/\n/g, '\r\n')) });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1').replace(/\r/g, '');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { sh.line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    sock.on('error', () => {});
    sock.write('WebTV bridge box shell (emulated box). help lists the commands.\r\n');
    sh.start();
  }).listen(port, '127.0.0.1', () => console.error(`[boxshell] nc 127.0.0.1 ${port}`));
  const tick = () => { m.run(2e6); setImmediate(tick); };   // keep the box running between connections
  tick();
}
