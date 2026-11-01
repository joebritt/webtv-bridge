// Disassemble a build by symbol, naming jal/j/branch targets, globals and strings (lui + addiu/ori).
//   node tools/symdis.mjs <build dir with _approm.o + symbols.sym> <symbol | hex address> [words]
//   node tools/symdis.mjs <build dir> /list <regex>        symbols matching regex
// Without a word count it stops at the next symbol. Reads both symbol file formats
// ([addr][name\0] and the 1998 TIMN format).
import { readFileSync } from 'node:fs';
import { disasm } from '../src/cpu/disasm.js';
import { parseSymbols } from '../src/lptmodem/patch.js';
const [dir, what, cnt] = process.argv.slice(2);
const img = readFileSync(dir + '/_approm.o'), sy = readFileSync(dir + '/symbols.sym');
const base = img.readUInt32BE(0x30) >>> 0;
const syms = [];
if (sy.toString('latin1', 0, 4) === 'TIMN') syms.push(...parseSymbols(sy).list); // 1998 format
else { // 16-byte header then [addr][name\0]
  let p = 16;
  while (p + 4 < sy.length) { const a = sy.readUInt32BE(p) >>> 0; p += 4; let e = p; while (e < sy.length && sy[e]) e++; const n = sy.toString('latin1', p, e); if (!/[\n\r]/.test(n)) syms.push([a, n]); p = e + 1; }
}
syms.sort((x, y) => x[0] - y[0]);
const byName = new Map(syms.map(([a, n]) => [n, a]));
const name = (a) => { let lo = 0, hi = syms.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (syms[m][0] <= a) { r = m; lo = m + 1; } else hi = m - 1; } if (r < 0) return null; const off = a - syms[r][0]; return off ? `${syms[r][1]}+${off.toString(16)}` : syms[r][1]; };
const rd = (a) => { const o = a - base; return o >= 0 && o + 4 <= img.length ? img.readUInt32BE(o) >>> 0 : null; };
const str = (a) => { const o = a - base; if (o < 0 || o >= img.length) return null; let e = o; while (e < img.length && img[e] >= 9 && img[e] < 127 && e - o < 80) e++; return e - o >= 3 && img[e] === 0 ? JSON.stringify(img.toString('latin1', o, e)) : null; };
if (what === '/list') { const re = new RegExp(cnt, 'i'); for (const [a, n] of syms) if (re.test(n)) console.log(a.toString(16), n); process.exit(); }
let start = byName.get(what) ?? parseInt(what, 16);
let end;
if (cnt) end = start + 4 * +cnt; else { const i = syms.findIndex(([a]) => a > start); end = i >= 0 ? syms[i][0] : start + 400; }
const hi = {};
console.log(`; base ${base.toString(16)}  ${name(start)}`);
for (let a = start; a < end; a += 4) {
  const op = rd(a); if (op == null) break;
  let t = disasm(op, a), note = '';
  const opc = op >>> 26, rs = (op >> 21) & 31, rt = (op >> 16) & 31, imm = op & 0xffff, simm = (imm << 16) >> 16;
  if (opc === 3 || opc === 2) { const tg = ((a & 0xf0000000) | ((op & 0x3ffffff) << 2)) >>> 0; note = name(tg); }
  if (opc === 0xf) hi[rt] = imm << 16;  // lui: remember for the next addiu/ori/load/store
  else if ((opc === 9 || opc === 0xd) && hi[rs] !== undefined) { const v = (opc === 9 ? hi[rs] + simm : hi[rs] | imm) >>> 0; note = str(v) || name(v) || v.toString(16); }
  else if ([0x20,0x21,0x23,0x24,0x25,0x28,0x29,0x2b].includes(opc) && hi[rs] !== undefined) { const v = (hi[rs] + simm) >>> 0; note = name(v) || v.toString(16); }
  if (opc === 4 || opc === 5 || opc === 1 || opc === 6 || opc === 7) { const tg = (a + 4 + (simm << 2)) >>> 0; note = name(tg); }
  if (name(a) && !name(a).includes('+')) console.log(`${name(a)}:`);
  console.log(a.toString(16), op.toString(16).padStart(8, '0'), t.padEnd(32), note ? '; ' + note : '');
}
