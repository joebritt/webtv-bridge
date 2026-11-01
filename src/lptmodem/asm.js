// Small two-pass MIPS I assembler for OS patches (big-endian, no reordering: delay slots are
// written explicitly).
//
//   const prog = parse(source);            // -> { units, equ }
//   const size = unitSize(unit);           // bytes
//   const bytes = assemble(unit, addr, resolve);   // resolve(name) -> address/value
//
// Source syntax: one statement per line, `#` comments, `name:` labels, `.func name` ...
// `.endfunc` placement units, `.equ NAME, expr`, `.word expr`. Operands: registers by
// name ($ optional), expressions with + - * | & << >> ( ), %hi(expr) / %lo(expr), and
// `off(reg)` memory operands. Pseudo-ops: nop, move, li (constant), la (always lui+addiu),
// b, beqz, bnez.

const REGS = ['zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'];
const RTYPE = { addu: 0x21, subu: 0x23, and: 0x24, or: 0x25, xor: 0x26, nor: 0x27, slt: 0x2a, sltu: 0x2b };
const VSHIFT = { sllv: 0x04, srlv: 0x06, srav: 0x07 }; // op rd, rt, rs
const SHIFT = { sll: 0x00, srl: 0x02, sra: 0x03 };
const ITYPE = { addiu: 0x09, slti: 0x0a, sltiu: 0x0b, andi: 0x0c, ori: 0x0d, xori: 0x0e };
const MEM = { lb: 0x20, lh: 0x21, lw: 0x23, lbu: 0x24, lhu: 0x25, sb: 0x28, sh: 0x29, sw: 0x2b };
const BR2 = { beq: 0x04, bne: 0x05 };
const BR1 = { blez: [0x06, 0], bgtz: [0x07, 0], bltz: [0x01, 0], bgez: [0x01, 1] };

export class AsmError extends Error {}

function reg(s, ctx) {
  const n = s.replace(/^\$/, '');
  const i = REGS.indexOf(n === 's8' ? 'fp' : n);
  if (i >= 0) return i;
  if (/^\d+$/.test(n) && +n < 32) return +n;
  throw new AsmError(`${ctx}: bad register '${s}'`);
}

// expression evaluator; `lookup(name)` returns a number or undefined (unknown -> null result)
function evaluate(src, lookup, ctx) {
  const toks = src.match(/%hi|%lo|0x[0-9a-fA-F]+|\d+|[A-Za-z_.$][\w.$]*|<<|>>|[-+*|&()~]/g) || [];
  if (toks.join('') !== src.replace(/\s+/g, '')) throw new AsmError(`${ctx}: bad expression '${src}'`);
  let i = 0, unknown = false;
  const peek = () => toks[i], next = () => toks[i++];
  const prim = () => {
    const t = next();
    if (t === undefined) throw new AsmError(`${ctx}: unexpected end of '${src}'`);
    if (t === '(') { const v = expr(); if (next() !== ')') throw new AsmError(`${ctx}: missing ) in '${src}'`); return v; }
    if (t === '-') return -prim();
    if (t === '~') return ~prim();
    if (t === '%hi' || t === '%lo') {
      if (next() !== '(') throw new AsmError(`${ctx}: ${t} needs (`);
      const v = expr();
      if (next() !== ')') throw new AsmError(`${ctx}: missing ) after ${t}`);
      return t === '%hi' ? ((v + 0x8000) >>> 16) & 0xffff : ((v & 0xffff) << 16) >> 16;
    }
    if (/^\d/.test(t)) return Number(t);
    const v = lookup(t);
    if (v === undefined) { unknown = true; return 0; }
    return v;
  };
  const mul = () => { let v = prim(); while (peek() === '*') { next(); v = Math.imul(v, prim()); } return v; };
  const add = () => { let v = mul(); while (peek() === '+' || peek() === '-') v = next() === '+' ? v + mul() : v - mul(); return v; };
  const shift = () => { let v = add(); while (peek() === '<<' || peek() === '>>') v = next() === '<<' ? v << add() : v >>> add(); return v; };
  const and = () => { let v = shift(); while (peek() === '&') { next(); v &= shift(); } return v; };
  const expr = () => { let v = and(); while (peek() === '|') { next(); v |= and(); } return v; };
  const v = expr();
  if (i !== toks.length) throw new AsmError(`${ctx}: trailing junk in '${src}'`);
  return unknown ? null : v;
}

function splitOperands(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// -> { units: [{ name, lines: [{ label?, op?, args, ctx }] }], equ: Map }
export function parse(source, file = 'asm') {
  const units = [], equ = new Map();
  let unit = null;
  source.split('\n').forEach((raw, n) => {
    const ctx = `${file}:${n + 1}`;
    let line = raw.replace(/#.*/, '').trim();
    if (!line) return;
    let m;
    while ((m = line.match(/^([A-Za-z_.$][\w.$]*):\s*(.*)$/))) {
      if (!unit) throw new AsmError(`${ctx}: label outside .func`);
      unit.lines.push({ label: m[1], ctx });
      line = m[2].trim();
    }
    if (!line) return;
    const [op, ...rest] = line.split(/\s+/);
    const args = splitOperands(rest.join(' '));
    if (op === '.func') { if (unit) throw new AsmError(`${ctx}: nested .func`); unit = { name: args[0], lines: [{ label: args[0], ctx }] }; return; }
    if (op === '.endfunc') { if (!unit) throw new AsmError(`${ctx}: .endfunc without .func`); units.push(unit); unit = null; return; }
    if (op === '.equ') { equ.set(args[0], args.slice(1).join(',')); return; }
    if (!unit) throw new AsmError(`${ctx}: code outside .func`);
    unit.lines.push({ op: op.toLowerCase(), args, ctx });
  });
  if (unit) throw new AsmError(`${file}: missing .endfunc for ${unit.name}`);
  return { units, equ };
}

const insnCount = (l) => (l.op === 'la' ? 2 : l.op === 'li' ? l.liWords || 2 : l.op ? 1 : 0);

// decide `li` sizes once constants are known
export function prepare(unit, lookup) {
  for (const l of unit.lines) {
    if (l.op !== 'li') continue;
    const v = evaluate(l.args[1], lookup, l.ctx);
    if (v === null) throw new AsmError(`${l.ctx}: li needs a constant (use la for addresses)`);
    l.liValue = v | 0;
    l.liWords = (l.liValue >= -0x8000 && l.liValue < 0x8000) || (l.liValue >>> 0) <= 0xffff ? 1 : 2;
  }
}

export const unitSize = (unit) => unit.lines.reduce((s, l) => s + insnCount(l) * 4, 0);

export function unitLabels(unit, addr) {
  const labels = new Map();
  let pc = addr;
  for (const l of unit.lines) {
    if (l.label) labels.set(l.label, pc >>> 0);
    pc += insnCount(l) * 4;
  }
  return labels;
}

// Assemble a unit at `addr`. lookup(name) -> number|undefined. Returns Uint8Array.
export function assemble(unit, addr, lookup) {
  const out = [];
  let pc = addr >>> 0;
  const val = (s, ctx) => {
    const v = evaluate(s, lookup, ctx);
    if (v === null) throw new AsmError(`${ctx}: undefined symbol in '${s}'`);
    return v;
  };
  const emit = (w) => { out.push(w >>> 0); pc = (pc + 4) >>> 0; };
  const imm16 = (v, ctx, signed) => {
    if (signed ? (v < -0x8000 || v > 0x7fff) : (v < -0x8000 || v > 0xffff)) throw new AsmError(`${ctx}: immediate ${v} out of range`);
    return v & 0xffff;
  };
  const branchOff = (target, ctx) => {
    const d = ((target >>> 0) - ((pc + 4) >>> 0)) | 0;
    if (d & 3 || d < -0x20000 || d > 0x1fffc) throw new AsmError(`${ctx}: branch target out of range`);
    return (d >> 2) & 0xffff;
  };
  for (const l of unit.lines) {
    if (!l.op) continue;
    const a = l.args, c = l.ctx, op = l.op;
    const need = (n) => { if (a.length !== n) throw new AsmError(`${c}: ${op} takes ${n} operands`); };
    if (op === 'nop') { emit(0); continue; }
    if (op === '.word') { need(1); emit(val(a[0], c)); continue; }
    if (op === 'move') { need(2); emit((reg(a[1], c) << 21) | (reg(a[0], c) << 11) | 0x21); continue; }
    if (op === 'li') {
      need(2);
      const rt = reg(a[0], c), v = l.liValue;
      if (l.liWords === 1) {
        if (v >= -0x8000 && v < 0x8000) emit((0x09 << 26) | (rt << 16) | (v & 0xffff));
        else emit((0x0d << 26) | (rt << 16) | (v & 0xffff));
      } else {
        emit((0x0f << 26) | (rt << 16) | ((v >>> 16) & 0xffff));
        emit((0x0d << 26) | (rt << 21) | (rt << 16) | (v & 0xffff));
      }
      continue;
    }
    if (op === 'la') {
      need(2);
      const rt = reg(a[0], c), v = val(a[1], c);
      emit((0x0f << 26) | (rt << 16) | (((v + 0x8000) >>> 16) & 0xffff));
      emit((0x09 << 26) | (rt << 21) | (rt << 16) | (v & 0xffff));
      continue;
    }
    if (op in RTYPE) { need(3); emit((reg(a[1], c) << 21) | (reg(a[2], c) << 16) | (reg(a[0], c) << 11) | RTYPE[op]); continue; }
    if (op in VSHIFT) { need(3); emit((reg(a[2], c) << 21) | (reg(a[1], c) << 16) | (reg(a[0], c) << 11) | VSHIFT[op]); continue; }
    if (op in SHIFT) { need(3); const sa = val(a[2], c); if (sa < 0 || sa > 31) throw new AsmError(`${c}: shift out of range`); emit((reg(a[1], c) << 16) | (reg(a[0], c) << 11) | (sa << 6) | SHIFT[op]); continue; }
    if (op in ITYPE) { need(3); const signed = op === 'addiu' || op === 'slti' || op === 'sltiu'; emit((ITYPE[op] << 26) | (reg(a[1], c) << 21) | (reg(a[0], c) << 16) | imm16(val(a[2], c), c, signed)); continue; }
    if (op === 'lui') { need(2); emit((0x0f << 26) | (reg(a[0], c) << 16) | imm16(val(a[1], c), c, false)); continue; }
    if (op in MEM) {
      need(2);
      const m = a[1].match(/^(.*)\((\$?\w+)\)$/);
      if (!m) throw new AsmError(`${c}: ${op} needs off(reg)`);
      const off = m[1].trim() ? val(m[1].trim(), c) : 0;
      emit((MEM[op] << 26) | (reg(m[2], c) << 21) | (reg(a[0], c) << 16) | imm16(off, c, true));
      continue;
    }
    if (op in BR2) { need(3); emit((BR2[op] << 26) | (reg(a[0], c) << 21) | (reg(a[1], c) << 16) | branchOff(val(a[2], c), c)); continue; }
    if (op === 'b') { need(1); emit((0x04 << 26) | branchOff(val(a[0], c), c)); continue; }
    if (op === 'beqz' || op === 'bnez') { need(2); emit(((op === 'beqz' ? 4 : 5) << 26) | (reg(a[0], c) << 21) | branchOff(val(a[1], c), c)); continue; }
    if (op in BR1) { need(2); const [o, rt] = BR1[op]; emit((o << 26) | (reg(a[0], c) << 21) | (rt << 16) | branchOff(val(a[1], c), c)); continue; }
    if (op === 'j' || op === 'jal') {
      need(1);
      const t = val(a[0], c) >>> 0;
      if ((t & 0xf0000000) !== ((pc + 4) & 0xf0000000) || t & 3) throw new AsmError(`${c}: ${op} target out of segment`);
      emit(((op === 'j' ? 2 : 3) << 26) | ((t >>> 2) & 0x3ffffff));
      continue;
    }
    if (op === 'mult' || op === 'multu') { need(2); emit((reg(a[0], c) << 21) | (reg(a[1], c) << 16) | (op === 'mult' ? 0x18 : 0x19)); continue; }
    if (op === 'mfhi' || op === 'mflo') { need(1); emit((reg(a[0], c) << 11) | (op === 'mfhi' ? 0x10 : 0x12)); continue; }
    if (op === 'jr') { need(1); emit((reg(a[0], c) << 21) | 0x08); continue; }
    if (op === 'jalr') { need(1); emit((reg(a[0], c) << 21) | (31 << 11) | 0x09); continue; }
    if (op === 'mfc0' || op === 'mtc0') { need(2); emit((0x10 << 26) | ((op === 'mfc0' ? 0 : 4) << 21) | (reg(a[0], c) << 16) | (val(a[1].replace(/^\$/, ''), c) << 11)); continue; }
    throw new AsmError(`${c}: unknown instruction '${op}'`);
  }
  const bytes = new Uint8Array(out.length * 4);
  out.forEach((w, i) => { bytes[i * 4] = w >>> 24; bytes[i * 4 + 1] = w >>> 16; bytes[i * 4 + 2] = w >>> 8; bytes[i * 4 + 3] = w; });
  return bytes;
}

export { evaluate };
