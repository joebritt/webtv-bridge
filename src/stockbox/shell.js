// The bridge's box shell: a line-at-a-time command interpreter over the box's memory
// (boxmem.js), the same on USB serial and telnet. Numbers are hex, as in the boot ROM's
// monitor. Everything beyond read / write / call is built here, on the bridge side.
//
//   const sh = new BoxShell(mem, { out });   out(text) to the user
//   sh.line('dm 80400000 40');               lines queue up and run in order; prompt 'box> '

import { checkRange } from './boxmem.js';

const HELP = `box shell (numbers in hex)
  dm <addr> [len]            dump memory (words when aligned, else bytes)
  dsl|dsh|dsb <addr>         read a word, halfword or byte
  sl|sh|sb <addr> <data...>  write words, halfwords or bytes
  call <addr> [a0 a1 a2 a3]  call a routine; prints v0
  fill <addr> <len> <word>   fill with a word
  find <addr> <len> <word>   find a word (aligned)
  help
`;

const h8 = (v) => (v >>> 0).toString(16).padStart(8, '0');
const hx = (v, w) => (v >>> 0).toString(16).padStart(w * 2, '0');
const WIDTH = { l: 4, h: 2, b: 1 };

export class BoxShell {
  constructor(mem, { out = () => {}, prompt = 'box> ' } = {}) {
    this.mem = mem; this.out = out; this.prompt = prompt;
    this.lines = [];
    this.running = false;
  }

  get busy() { return this.running || this.lines.length > 0; }

  start() { this.out(this.prompt); }

  line(text) { this.lines.push(text.trim()); if (!this.running) this.run(); }

  run() {
    const text = this.lines.shift();
    if (text === undefined) { this.running = false; return; }
    this.running = true;
    const done = (msg) => { if (msg) this.out(msg.endsWith('\n') ? msg : msg + '\n'); this.out(this.prompt); this.run(); };
    if (!text) { done(); return; }
    try { this.exec(text.split(/\s+/), done); } catch (e) { done(`>> ${e.message}`); }
  }

  exec([cmd, ...args], done) {
    const num = (s, what) => {
      if (s === undefined || !/^(0x)?[0-9a-f]+$/i.test(s)) throw new Error(`${what}: hex number expected`);
      return parseInt(s.replace(/^0x/i, ''), 16) >>> 0;
    };
    const fail = (addr) => (err) => done(`>> ${h8(addr)}: ${err}`);
    let m;
    if (cmd === 'help' || cmd === '?') return done(HELP);
    if (cmd === 'dm') {
      const addr = num(args[0], 'address'), len = args[1] ? num(args[1], 'length') : 0x40;
      const width = addr % 4 === 0 && len % 4 === 0 ? 4 : 1;
      return this.mem.read(addr, width, len / width, (err, vals) => {
        if (err) return fail(addr)(err);
        const bytes = vals.flatMap((v) => (width === 4 ? [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255] : [v]));
        let s = '';
        for (let o = 0; o < bytes.length; o += 16) {
          const row = bytes.slice(o, o + 16);
          const hex = width === 4
            ? Array.from({ length: row.length / 4 }, (_, i) => row.slice(i * 4, i * 4 + 4).map((b) => hx(b, 1)).join('')).join(' ').padEnd(35)
            : row.map((b) => hx(b, 1)).join(' ').padEnd(47);
          s += `${h8(addr + o)}: ${hex}  ${row.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}\n`;
        }
        done(s);
      });
    }
    if ((m = cmd.match(/^ds([lhb])$/))) {
      const addr = num(args[0], 'address'), w = WIDTH[m[1]];
      return this.mem.read(addr, w, 1, (err, [v] = []) => (err ? fail(addr)(err) : done(`${h8(addr)}: ${hx(v, w)} (${v})`)));
    }
    if ((m = cmd.match(/^s([lhb])$/))) {
      const addr = num(args[0], 'address'), w = WIDTH[m[1]];
      if (args.length < 2) throw new Error('data expected');
      const vals = args.slice(1).map((a) => num(a, 'data'));
      if (vals.some((v) => w < 4 && v >>> (8 * w))) throw new Error(`data wider than ${w} byte${w > 1 ? 's' : ''}`);
      return this.mem.write(addr, w, vals, (err) => (err ? fail(addr)(err) : done()));
    }
    if (cmd === 'call') {
      const addr = num(args[0], 'address'), a = args.slice(1, 5).map((x) => num(x, 'argument'));
      return this.mem.call(addr, a, (err, v0) => (err ? fail(addr)(err) : done(`v0 = ${h8(v0)} (${v0 | 0})`)));
    }
    if (cmd === 'fill') {
      const addr = num(args[0], 'address'), len = num(args[1], 'length'), word = num(args[2], 'word');
      if (addr % 4 || len % 4) throw new Error('address and length must be multiples of 4');
      return this.mem.write(addr, 4, new Array(len / 4).fill(word), (err) => (err ? fail(addr)(err) : done(`filled ${len.toString(16)} bytes`)));
    }
    if (cmd === 'find') {
      const addr = num(args[0], 'address'), len = num(args[1], 'length'), word = num(args[2], 'word');
      if (addr % 4) throw new Error('address must be a multiple of 4');
      const bad = checkRange(addr, 4, len >>> 2);
      if (bad) return fail(addr)(bad);
      return this.mem.read(addr, 4, len >>> 2, (err, vals) => {
        if (err) return fail(addr)(err);
        const hits = vals.flatMap((v, i) => (v === word ? [h8(addr + i * 4)] : []));
        done(hits.length ? `${hits.length} found: ${hits.slice(0, 16).join(' ')}${hits.length > 16 ? ' ...' : ''}` : `${h8(word)} not found`);
      });
    }
    throw new Error(`${cmd}: unknown command (help lists them)`);
  }
}
