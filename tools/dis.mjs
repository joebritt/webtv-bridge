// Usage: node tools/dis.mjs <romfile> <startVA hex> <count> [baseVA hex = bfc00000]
import { readFileSync } from 'node:fs';
import { disasm } from '../src/cpu/disasm.js';
const [file, start, count = '64', base = 'bfc00000'] = process.argv.slice(2);
const buf = readFileSync(file);
const b = parseInt(base, 16), s = parseInt(start, 16);
for (let i = 0; i < +count; i++) {
  const va = (s + i * 4) >>> 0;
  const off = va - b;
  if (off < 0 || off + 4 > buf.length) break;
  const op = buf.readUInt32BE(off);
  console.log(va.toString(16).padStart(8, '0'), op.toString(16).padStart(8, '0'), disasm(op, va));
}
