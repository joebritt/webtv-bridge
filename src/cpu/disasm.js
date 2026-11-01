// Compact MIPS III disassembler for debugging/tracing.

const R = ['zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 's8', 'ra'];

const hex = (v, n = 8) => (v >>> 0).toString(16).padStart(n, '0');
const shex = (v) => (v < 0 ? '-0x' + (-v).toString(16) : '0x' + v.toString(16));

const SPECIAL = {
  0x00: 'sll', 0x02: 'srl', 0x03: 'sra', 0x04: 'sllv', 0x06: 'srlv', 0x07: 'srav', 0x08: 'jr', 0x09: 'jalr',
  0x0a: 'movz', 0x0b: 'movn', 0x0c: 'syscall', 0x0d: 'break', 0x0f: 'sync', 0x10: 'mfhi', 0x11: 'mthi',
  0x12: 'mflo', 0x13: 'mtlo', 0x14: 'dsllv', 0x16: 'dsrlv', 0x17: 'dsrav', 0x18: 'mult', 0x19: 'multu',
  0x1a: 'div', 0x1b: 'divu', 0x1c: 'dmult', 0x1d: 'dmultu', 0x1e: 'ddiv', 0x1f: 'ddivu', 0x20: 'add',
  0x21: 'addu', 0x22: 'sub', 0x23: 'subu', 0x24: 'and', 0x25: 'or', 0x26: 'xor', 0x27: 'nor', 0x2a: 'slt',
  0x2b: 'sltu', 0x2c: 'dadd', 0x2d: 'daddu', 0x2e: 'dsub', 0x2f: 'dsubu', 0x30: 'tge', 0x31: 'tgeu',
  0x32: 'tlt', 0x33: 'tltu', 0x34: 'teq', 0x36: 'tne', 0x38: 'dsll', 0x3a: 'dsrl', 0x3b: 'dsra',
  0x3c: 'dsll32', 0x3e: 'dsrl32', 0x3f: 'dsra32',
};
const IMM = {
  0x08: 'addi', 0x09: 'addiu', 0x0a: 'slti', 0x0b: 'sltiu', 0x0c: 'andi', 0x0d: 'ori', 0x0e: 'xori',
  0x18: 'daddi', 0x19: 'daddiu',
};
const MEM = {
  0x1a: 'ldl', 0x1b: 'ldr', 0x20: 'lb', 0x21: 'lh', 0x22: 'lwl', 0x23: 'lw', 0x24: 'lbu', 0x25: 'lhu',
  0x26: 'lwr', 0x27: 'lwu', 0x28: 'sb', 0x29: 'sh', 0x2a: 'swl', 0x2b: 'sw', 0x2c: 'sdl', 0x2d: 'sdr',
  0x2e: 'swr', 0x30: 'll', 0x34: 'lld', 0x37: 'ld', 0x38: 'sc', 0x3c: 'scd', 0x3f: 'sd',
};
const FMEM = { 0x31: 'lwc1', 0x35: 'ldc1', 0x39: 'swc1', 0x3d: 'sdc1' };
const BR = { 0x04: 'beq', 0x05: 'bne', 0x06: 'blez', 0x07: 'bgtz', 0x14: 'beql', 0x15: 'bnel', 0x16: 'blezl', 0x17: 'bgtzl' };
const REGIMM = { 0: 'bltz', 1: 'bgez', 2: 'bltzl', 3: 'bgezl', 0x10: 'bltzal', 0x11: 'bgezal', 0x12: 'bltzall', 0x13: 'bgezall',
  8: 'tgei', 9: 'tgeiu', 10: 'tlti', 11: 'tltiu', 12: 'teqi', 14: 'tnei' };
const FOPS = { 0: 'add', 1: 'sub', 2: 'mul', 3: 'div', 4: 'sqrt', 5: 'abs', 6: 'mov', 7: 'neg', 8: 'round.l', 9: 'trunc.l',
  10: 'ceil.l', 11: 'floor.l', 12: 'round.w', 13: 'trunc.w', 14: 'ceil.w', 15: 'floor.w', 0x20: 'cvt.s', 0x21: 'cvt.d',
  0x24: 'cvt.w', 0x25: 'cvt.l' };
const FCMP = ['f', 'un', 'eq', 'ueq', 'olt', 'ult', 'ole', 'ule', 'sf', 'ngle', 'seq', 'ngl', 'lt', 'nge', 'le', 'ngt'];

export function disasm(op, pc) {
  op >>>= 0;
  const rs = (op >>> 21) & 31, rt = (op >>> 16) & 31, rd = (op >>> 11) & 31, sa = (op >>> 6) & 31;
  const imm = (op << 16) >> 16, uimm = op & 0xffff;
  const btarget = () => hex((pc + 4 + (imm << 2)) >>> 0);
  const o = op >>> 26;
  if (op === 0) return 'nop';
  if (o === 0) {
    const f = op & 0x3f, n = SPECIAL[f];
    if (!n) return `.word 0x${hex(op)}`;
    if (f <= 3 || (f >= 0x38)) return `${n} ${R[rd]}, ${R[rt]}, ${sa}`;
    if (f <= 7 || f === 0x14 || f === 0x16 || f === 0x17) return `${n} ${R[rd]}, ${R[rt]}, ${R[rs]}`;
    if (f === 8) return `jr ${R[rs]}`;
    if (f === 9) return `jalr ${rd === 31 ? '' : R[rd] + ', '}${R[rs]}`;
    if (f === 0x0c || f === 0x0d) return `${n} 0x${((op >>> 6) & 0xfffff).toString(16)}`;
    if (f === 0x0f) return n;
    if (f === 0x10 || f === 0x12) return `${n} ${R[rd]}`;
    if (f === 0x11 || f === 0x13) return `${n} ${R[rs]}`;
    if (f >= 0x18 && f <= 0x1f) return `${n} ${R[rs]}, ${R[rt]}`;
    if (f >= 0x30 && f <= 0x36) return `${n} ${R[rs]}, ${R[rt]}`;
    if (f === 0x25 && rt === 0) return `move ${R[rd]}, ${R[rs]}`;
    return `${n} ${R[rd]}, ${R[rs]}, ${R[rt]}`;
  }
  if (o === 1) {
    const n = REGIMM[rt];
    if (!n) return `.word 0x${hex(op)}`;
    if (rt >= 8 && rt <= 14) return `${n} ${R[rs]}, ${shex(imm)}`;
    return `${n} ${R[rs]}, ${btarget()}`;
  }
  if (o === 2 || o === 3) return `${o === 2 ? 'j' : 'jal'} ${hex(((pc + 4) & 0xf0000000) | ((op & 0x3ffffff) << 2))}`;
  if (BR[o]) {
    const n = BR[o];
    if (o === 4 && rs === 0 && rt === 0) return `b ${btarget()}`;
    if ((o & 3) >= 2) return `${n} ${R[rs]}, ${btarget()}`;
    return `${n} ${R[rs]}, ${R[rt]}, ${btarget()}`;
  }
  if (IMM[o]) {
    const n = IMM[o];
    if (o >= 0x0c && o <= 0x0e) return `${n} ${R[rt]}, ${R[rs]}, 0x${uimm.toString(16)}`;
    if (o === 9 && rs === 0) return `li ${R[rt]}, ${shex(imm)}`;
    return `${n} ${R[rt]}, ${R[rs]}, ${shex(imm)}`;
  }
  if (o === 0x0f) return `lui ${R[rt]}, 0x${uimm.toString(16)}`;
  if (MEM[o]) return `${MEM[o]} ${R[rt]}, ${shex(imm)}(${R[rs]})`;
  if (FMEM[o]) return `${FMEM[o]} $f${rt}, ${shex(imm)}(${R[rs]})`;
  if (o === 0x2f) return `cache 0x${rt.toString(16)}, ${shex(imm)}(${R[rs]})`;
  if (o === 0x1c) {
    const f = op & 0x3f;
    if (f === 0) return `mad ${R[rs]}, ${R[rt]}`;
    if (f === 1) return `madu ${R[rs]}, ${R[rt]}`;
    if (f === 2) return `mul ${R[rd]}, ${R[rs]}, ${R[rt]}`;
  }
  if (o === 0x10) {
    if (rs === 0) return `mfc0 ${R[rt]}, $${rd}`;
    if (rs === 1) return `dmfc0 ${R[rt]}, $${rd}`;
    if (rs === 4) return `mtc0 ${R[rt]}, $${rd}`;
    if (rs === 5) return `dmtc0 ${R[rt]}, $${rd}`;
    if (rs >= 16) {
      const f = op & 0x3f;
      return { 1: 'tlbr', 2: 'tlbwi', 6: 'tlbwr', 8: 'tlbp', 0x18: 'eret', 0x20: 'wait' }[f] || `cop0 0x${hex(op)}`;
    }
  }
  if (o === 0x11) {
    const ft = rt, fs = rd, fd = sa;
    if (rs === 0) return `mfc1 ${R[rt]}, $f${fs}`;
    if (rs === 1) return `dmfc1 ${R[rt]}, $f${fs}`;
    if (rs === 2) return `cfc1 ${R[rt]}, $${fs}`;
    if (rs === 4) return `mtc1 ${R[rt]}, $f${fs}`;
    if (rs === 5) return `dmtc1 ${R[rt]}, $f${fs}`;
    if (rs === 6) return `ctc1 ${R[rt]}, $${fs}`;
    if (rs === 8) return `bc1${(op >>> 16) & 1 ? 't' : 'f'}${(op >>> 17) & 1 ? 'l' : ''} ${btarget()}`;
    const fmt = { 16: 's', 17: 'd', 20: 'w', 21: 'l' }[rs] || '?';
    const f = op & 0x3f;
    if (f >= 0x30) return `c.${FCMP[f & 15]}.${fmt} $f${fs}, $f${ft}`;
    if (FOPS[f]) return `${FOPS[f]}.${fmt} $f${fd}, $f${fs}${f < 4 ? ', $f' + ft : ''}`;
  }
  return `.word 0x${hex(op)}`;
}

export const REG_NAMES = R;
