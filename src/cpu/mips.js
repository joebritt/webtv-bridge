// MIPS III interpreter modelled on the IDT R4640 (big-endian), as used in the
// WebTV LC2 / SOLO1 boxes.
//
// GPRs are 64-bit, stored as two Int32Arrays (hi/lo halves). Almost all code the
// box runs is 32-bit, so the common path writes `lo` and sign-extends into `hi`.
//
// Address translation follows the R4640: in kernel mode the physical address is
// simply va & 0x1fffffff; in user/supervisor mode the IBase/IBound/DBase/DBound
// registers apply. There is no TLB.

const EXC_INT = 0, EXC_MOD = 1, EXC_TLBL = 2, EXC_TLBS = 3, EXC_ADEL = 4, EXC_ADES = 5,
  EXC_IBE = 6, EXC_DBE = 7, EXC_SYS = 8, EXC_BP = 9, EXC_RI = 10, EXC_CPU = 11,
  EXC_OV = 12, EXC_TR = 13, EXC_FPE = 15;

export const SR_IE = 0x1, SR_EXL = 0x2, SR_ERL = 0x4, SR_KSU = 0x18, SR_BEV = 0x400000,
  SR_FR = 0x04000000, SR_CU1 = 0x20000000;
const CAUSE_IV = 0x00800000;

// CP0 register numbers
const C0_IBASE = 0, C0_IBOUND = 1, C0_DBASE = 2, C0_DBOUND = 3, C0_BADVADDR = 8, C0_COUNT = 9,
  C0_COMPARE = 11, C0_STATUS = 12, C0_CAUSE = 13, C0_EPC = 14, C0_PRID = 15, C0_CONFIG = 16,
  C0_CALG = 17, C0_IWATCH = 18, C0_DWATCH = 19, C0_ECC = 26, C0_CACHEERR = 27, C0_TAGLO = 28,
  C0_TAGHI = 29, C0_ERROREPC = 30;

// Thrown (rarely) to abort the current instruction after an exception has been raised.
class MipsException { }
const ABORT = new MipsException();

// float <-> bits scratch
const fbuf = new ArrayBuffer(8);
const f32 = new Float32Array(fbuf);
const f64 = new Float64Array(fbuf);
const u32 = new Uint32Array(fbuf); // little-endian host: u32[0] = low word of the double
const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const DLO = LE ? 0 : 1, DHI = LE ? 1 : 0;

const TWO32 = 4294967296;

import { Jit, COLD } from './jit.js';

export class MipsCpu {
  /**
   * @param {object} bus  physical bus: read8/16/32, write8/16/32 (32-bit physical address)
   *                      plus optional `ram` (Int32Array) / `ramMask` and `rom` / `romMask`, `romBase`
   *                      for fast paths.
   */
  constructor(bus) {
    this.bus = bus;
    this.gprL = new Int32Array(32);
    this.gprH = new Int32Array(32);
    this.hiL = 0; this.hiH = 0; this.loL = 0; this.loH = 0;
    this.cp0 = new Int32Array(32);
    this.fpr = new Int32Array(32);   // FR=0 layout: 32 x 32-bit, doubles in even/odd pairs
    this.fpr64H = new Int32Array(32); // FR=1 upper halves
    this.fcr31 = 0;
    this.pc = 0; this.npc = 0; this.curPC = 0;
    this.stopRequested = false;
    this.inDelay = false;     // instruction currently executing is in a delay slot
    this.nextIsDelay = false; // a branch just executed: next instruction is in its delay slot
    this.llbit = false;
    this.cycles = 0;           // total instructions executed (approximates CPU cycles)
    this.interpSteps = 0;      // dispatcher fell back to the interpreter (stats)
    this.countBase = 0;        // cycles value when Count was last written
    this.countOffset = 0;
    this.irqLines = 0;         // external interrupt lines -> Cause IP2..IP6 (bit0 = IP2)
    this.timerIrq = false;
    this.halted = false;
    this.traceHook = null;
    this.unimplLogged = new Set();
    this.log = (...a) => console.log(...a);
    this.ramMask = bus.ramMask;
    this.jit = new Jit(this);
    this.useJit = true;
    bus.jit = this.jit;
    this.excTaken = false;
    this.reset();
  }

  reset() {
    this.gprL.fill(0); this.gprH.fill(0);
    this.cp0.fill(0);
    this.cp0[C0_STATUS] = SR_BEV | SR_ERL;
    this.cp0[C0_CAUSE] = CAUSE_IV;
    this.cp0[C0_COMPARE] = -1;
    this.cp0[C0_PRID] = 0x2200;
    this.cp0[C0_CONFIG] = 0x00026030 | 0;
    this.fcr31 = 0;
    this.pc = 0xbfc00000 | 0;
    this.npc = (this.pc + 4) | 0;
    this.inDelay = false;
    this.nextIsDelay = false;
    this.countBase = this.cycles;
    this.countOffset = 0;
    this.timerIrq = false;
  }

  // ---------------------------------------------------------------- CP0 Count/Compare

  getCount() {
    return (this.countOffset + Math.floor((this.cycles - this.countBase) / 2)) | 0;
  }
  setCount(v) {
    this.countOffset = v | 0;
    this.countBase = this.cycles;
  }
  /** cycles until Count == Compare (>= 1) */
  cyclesToCompare() {
    const diff = ((this.cp0[C0_COMPARE] - this.getCount()) >>> 0);
    return diff === 0 ? 2 * TWO32 : diff * 2;
  }

  // ---------------------------------------------------------------- interrupts

  setIrqLine(line, state) { // line 0..4 => IP2..IP6
    if (state) this.irqLines |= (1 << line); else this.irqLines &= ~(1 << line);
  }

  updateCause() {
    let c = this.cp0[C0_CAUSE] & ~0x7c00;
    c |= (this.irqLines & 0x1f) << 10;
    if (this.timerIrq) c |= 0x8000;
    this.cp0[C0_CAUSE] = c;
    return c;
  }

  interruptPending() {
    const sr = this.cp0[C0_STATUS];
    if ((sr & (SR_IE | SR_EXL | SR_ERL)) !== SR_IE) return false;
    const cause = this.updateCause();
    return (cause & sr & 0xff00) !== 0;
  }

  // ---------------------------------------------------------------- exceptions

  exception(code, badva) {
    const sr = this.cp0[C0_STATUS];
    let cause = this.cp0[C0_CAUSE];
    let offset = 0x180;
    if (code === EXC_INT && (cause & CAUSE_IV)) offset = 0x200;
    cause = (cause & ~0x8000007c) | (code << 2);
    if (badva !== undefined) this.cp0[C0_BADVADDR] = badva;
    if (!(sr & SR_EXL)) {
      if (this.inDelay) {
        this.cp0[C0_EPC] = (this.curPC - 4) | 0;
        cause |= 0x80000000;
      } else {
        this.cp0[C0_EPC] = this.curPC;
      }
      this.cp0[C0_STATUS] = sr | SR_EXL;
    }
    this.cp0[C0_CAUSE] = cause;
    this.excTaken = true;
    this.pc = (((sr & SR_BEV) ? 0xbfc00200 : 0x80000000) + offset) | 0;
    this.npc = (this.pc + 4) | 0;
    this.nextIsDelay = false;
    this.inDelay = false;
  }

  copUnusable(n) {
    this.exception(EXC_CPU);
    this.cp0[C0_CAUSE] = (this.cp0[C0_CAUSE] & ~0x30000000) | (n << 28);
  }

  // ---------------------------------------------------------------- address translation

  /** data address translation; returns physical address (uint32 as number) */
  xlate(va, store) {
    const sr = this.cp0[C0_STATUS];
    if ((sr & SR_KSU) === 0 || (sr & (SR_EXL | SR_ERL))) return va & 0x1fffffff;
    // user/supervisor mode: base/bound for kuseg
    if (va < 0) { this.exception(store ? EXC_ADES : EXC_ADEL, va); throw ABORT; }
    if ((va & 0xfffff000) > this.cp0[C0_DBOUND]) { this.exception(store ? EXC_TLBS : EXC_TLBL, va); throw ABORT; }
    return (va + this.cp0[C0_DBASE]) & 0x1fffffff;
  }

  xlateI(va) {
    const sr = this.cp0[C0_STATUS];
    if ((sr & SR_KSU) === 0 || (sr & (SR_EXL | SR_ERL))) return va & 0x1fffffff;
    if (va < 0) { this.exception(EXC_ADEL, va); throw ABORT; }
    if ((va & 0xfffff000) > this.cp0[C0_IBOUND]) { this.exception(EXC_TLBL, va); throw ABORT; }
    return (va + this.cp0[C0_IBASE]) & 0x1fffffff;
  }

  // ---------------------------------------------------------------- memory

  rd8(va) { return this.bus.read8(this.xlate(va, false)); }
  rd16(va) {
    if (va & 1) { this.exception(EXC_ADEL, va); throw ABORT; }
    return this.bus.read16(this.xlate(va, false));
  }
  rd32(va) {
    if (va & 3) { this.exception(EXC_ADEL, va); throw ABORT; }
    const pa = this.xlate(va, false);
    if (pa < 0x04000000) return this.bus.ram[(pa & this.bus.ramMask) >>> 2];
    return this.bus.read32(pa);
  }
  wr8(va, v) { this.bus.write8(this.xlate(va, true), v & 0xff); }
  wr16(va, v) {
    if (va & 1) { this.exception(EXC_ADES, va); throw ABORT; }
    this.bus.write16(this.xlate(va, true), v & 0xffff);
  }
  wr32(va, v) {
    if (va & 3) { this.exception(EXC_ADES, va); throw ABORT; }
    const pa = this.xlate(va, true);
    if (pa < 0x04000000) {
      this.bus.ram[(pa & this.bus.ramMask) >>> 2] = v;
      if (this.jit.codePages[pa >>> 12]) this.jit.invalidatePage(pa >>> 12);
      return;
    }
    this.bus.write32(pa, v | 0);
  }

  fetch(va) {
    if (va & 3) { this.exception(EXC_ADEL, va); throw ABORT; }
    const pa = this.xlateI(va);
    if (pa < 0x04000000) return this.bus.ram[(pa & this.bus.ramMask) >>> 2];
    if (pa >= this.bus.romBase) return this.bus.rom[((pa - this.bus.romBase) & this.bus.romMask) >>> 2];
    return this.bus.read32(pa);
  }

  // ---------------------------------------------------------------- helpers

  unimpl(op, what) {
    const key = what + ':' + (op >>> 26) + ':' + (op & 0x3f);
    if (!this.unimplLogged.has(key)) {
      this.unimplLogged.add(key);
      this.log(`[cpu] reserved/unimplemented ${what} op=${(op >>> 0).toString(16).padStart(8, '0')} pc=${(this.pc >>> 0).toString(16)}`);
    }
    this.exception(EXC_RI);
  }

  // signed/unsigned 32x32->64 multiply into HI/LO (32-bit results sign extended)
  mult32(a, b, signed) {
    const ua = a >>> 0, ub = b >>> 0;
    const al = ua & 0xffff, ah = ua >>> 16, bl = ub & 0xffff, bh = ub >>> 16;
    const ll = al * bl, lh = al * bh, hl = ah * bl, hh = ah * bh;
    const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
    const lo = ((mid << 16) | (ll & 0xffff)) | 0;
    let hi = (hh + (lh >>> 16) + (hl >>> 16) + Math.floor(mid / 65536)) | 0;
    if (signed) {
      if (a < 0) hi = (hi - b) | 0;
      if (b < 0) hi = (hi - a) | 0;
    }
    this.loL = lo; this.loH = lo >> 31;
    this.hiL = hi; this.hiH = hi >> 31;
  }

  // 64-bit values as BigInt (slow path for doubleword multiply/divide)
  big(r) { return (BigInt(this.gprH[r]) << 32n) | BigInt(this.gprL[r] >>> 0); }
  setBigHI(v) { this.hiL = Number(BigInt.asIntN(32, v)); this.hiH = Number(BigInt.asIntN(32, v >> 32n)); }
  setBigLO(v) { this.loL = Number(BigInt.asIntN(32, v)); this.loH = Number(BigInt.asIntN(32, v >> 32n)); }

  // ---------------------------------------------------------------- FPU helpers

  fprS(r) { u32[0] = this.fpr[r]; return f32[0]; }
  setS(r, v) { f32[0] = v; this.fpr[r] = u32[0] | 0; }
  fprD(r) {
    if (this.cp0[C0_STATUS] & SR_FR) { u32[DLO] = this.fpr[r]; u32[DHI] = this.fpr64H[r]; }
    else { u32[DLO] = this.fpr[r & ~1]; u32[DHI] = this.fpr[r | 1]; }
    return f64[0];
  }
  setD(r, v) {
    f64[0] = v;
    if (this.cp0[C0_STATUS] & SR_FR) { this.fpr[r] = u32[DLO] | 0; this.fpr64H[r] = u32[DHI] | 0; }
    else { this.fpr[r & ~1] = u32[DLO] | 0; this.fpr[r | 1] = u32[DHI] | 0; }
  }
  fprW(r) { return this.fpr[r]; }
  fprL(r) { // as Number (may lose precision beyond 2^53)
    let lo, hi;
    if (this.cp0[C0_STATUS] & SR_FR) { lo = this.fpr[r]; hi = this.fpr64H[r]; }
    else { lo = this.fpr[r & ~1]; hi = this.fpr[r | 1]; }
    return hi * TWO32 + (lo >>> 0);
  }
  setL(r, v) {
    const big = BigInt.asIntN(64, BigInt(Math.trunc(v)));
    const lo = Number(BigInt.asIntN(32, big)), hi = Number(BigInt.asIntN(32, big >> 32n));
    if (this.cp0[C0_STATUS] & SR_FR) { this.fpr[r] = lo; this.fpr64H[r] = hi; }
    else { this.fpr[r & ~1] = lo; this.fpr[r | 1] = hi; }
  }
  roundMode(v) {
    switch (this.fcr31 & 3) {
      case 0: { // round to nearest even
        const f = Math.floor(v), d = v - f;
        if (d > 0.5) return f + 1;
        if (d < 0.5) return f;
        return (f % 2 === 0) ? f : f + 1;
      }
      case 1: return Math.trunc(v);
      case 2: return Math.ceil(v);
      default: return Math.floor(v);
    }
  }
  toW(v) {
    if (!(v >= -2147483648 && v <= 2147483647)) return 0x7fffffff; // invalid -> default result
    return v | 0;
  }
  fpuCond(cc, val) {
    const bit = cc === 0 ? 0x00800000 : (1 << (24 + cc));
    if (val) this.fcr31 |= bit; else this.fcr31 &= ~bit;
  }
  fpuCC(cc) {
    const bit = cc === 0 ? 0x00800000 : (1 << (24 + cc));
    return (this.fcr31 & bit) !== 0;
  }

  // ---------------------------------------------------------------- main loop

  /**
   * Execute up to `count` instructions. Returns number executed.
   */
  run(count) {
    if (!this.useJit || this.traceHook) return this.interpret(count);
    const L = this.gprL, H = this.gprH, ram = this.bus.ram, jit = this.jit, cp0 = this.cp0;
    let n = 0;
    let prev = null;
    while (n < count) {
      if ((this.irqLines !== 0 || this.timerIrq || (cp0[C0_CAUSE] & 0x300) !== 0) && this.interruptPending()) {
        this.curPC = this.pc;
        this.inDelay = this.nextIsDelay;
        this.exception(EXC_INT);
        prev = null;
      }
      const sr = cp0[C0_STATUS];
      const pc = this.pc;
      if (this.nextIsDelay || ((sr & SR_KSU) !== 0 && (sr & (SR_EXL | SR_ERL)) === 0) || (pc & 3) !== 0) {
        this.interpSteps++;
        n += this.interpret(1);
        prev = null;
        if (this.stopHit) { this.stopHit = false; break; }
        continue;
      }
      let fn;
      if (prev !== null && prev.nxPc === pc && prev.nxFn !== null && !prev.nxFn.dead) fn = prev.nxFn;
      else {
        try { fn = jit.lookup(pc); } catch (e) { if (e !== ABORT) throw e; fn = null; jit.blocks.delete(pc); }
        if (fn === COLD) {
          n += this.interpretBlock();
          prev = null;
          if (this.stopHit) { this.stopHit = false; this.stopRequested = false; break; }
          continue;
        }
        if (fn === null) {
          this.interpSteps++;
          n += this.interpret(1);
          prev = null;
          if (this.stopHit) { this.stopHit = false; break; }
          continue;
        }
        if (prev !== null) { prev.nxPc = pc; prev.nxFn = fn; }
      }
      n += fn.len;
      this.cycles += fn.len;
      try {
        fn(this, L, H, ram);
        prev = fn;
      } catch (e) {
        if (e !== ABORT) throw e;
        prev = null;
      }
      if (this.stopRequested) { this.stopRequested = false; break; }
    }
    return n;
  }

  /**
   * Interpret one basic block (up to and including a branch and its delay slot), for code
   * the JIT hasn't compiled yet. Stops early on exceptions or other control transfers.
   */
  interpretBlock() {
    let n = 0;
    this.stopHit = false;
    while (n < 128) {
      const next = (this.pc + 4) | 0;
      n += this.interpret(1);
      if (this.stopHit) { this.stopRequested = true; break; } // let run() see it
      if (this.nextIsDelay) { n += this.interpret(1); break; } // took a branch: run its slot
      if (this.pc !== next) break; // exception, eret, ...
    }
    this.interpSteps += n;
    return n;
  }

  /** Plain interpreter: execute up to `count` instructions. */
  interpret(count) {
    const L = this.gprL, H = this.gprH;
    let n = 0;
    while (n < count) {
      if ((this.irqLines !== 0 || this.timerIrq || (this.cp0[C0_CAUSE] & 0x300) !== 0) && this.interruptPending()) {
        // EPC is the instruction about to run (or its branch, if it sits in a delay slot)
        this.curPC = this.pc;
        this.inDelay = this.nextIsDelay;
        this.exception(EXC_INT);
      }
      const pc = this.pc;
      this.curPC = pc;
      this.inDelay = this.nextIsDelay;
      this.nextIsDelay = false;
      n++;
      this.cycles++;
      let op;
      try {
        op = this.fetch(pc);
      } catch (e) {
        if (e === ABORT) continue;
        throw e;
      }
      this.pc = this.npc;
      this.npc = (this.npc + 4) | 0;
      if (this.traceHook) this.traceHook(pc, op);
      try {
        this.execute(op, pc, L, H);
      } catch (e) {
        if (e !== ABORT) throw e;
      }
      L[0] = 0; H[0] = 0;
      if (this.stopRequested) { this.stopRequested = false; this.stopHit = true; break; }
    }
    return n;
  }

  branch(target) {
    this.npc = target | 0;
    this.nextIsDelay = true;
  }

  execute(op, pc, L, H) {
    const rs = (op >>> 21) & 31, rt = (op >>> 16) & 31;
    switch (op >>> 26) {
      case 0x00: this.special(op, pc, L, H); break;
      case 0x01: this.regimm(op, pc, L, H); break;
      case 0x02: // J
        this.branch((((pc + 4) & 0xf0000000) | ((op & 0x03ffffff) << 2)));
        break;
      case 0x03: // JAL
        L[31] = (pc + 8) | 0; H[31] = L[31] >> 31;
        this.branch((((pc + 4) & 0xf0000000) | ((op & 0x03ffffff) << 2)));
        break;
      case 0x04: // BEQ
        this.nextIsDelay = true;
        if (L[rs] === L[rt] && H[rs] === H[rt]) this.npc = (pc + 4 + ((op << 16) >> 14)) | 0;
        break;
      case 0x05: // BNE
        this.nextIsDelay = true;
        if (L[rs] !== L[rt] || H[rs] !== H[rt]) this.npc = (pc + 4 + ((op << 16) >> 14)) | 0;
        break;
      case 0x06: // BLEZ
        this.nextIsDelay = true;
        if (H[rs] < 0 || (H[rs] === 0 && L[rs] === 0)) this.npc = (pc + 4 + ((op << 16) >> 14)) | 0;
        break;
      case 0x07: // BGTZ
        this.nextIsDelay = true;
        if (H[rs] > 0 || (H[rs] === 0 && L[rs] !== 0)) this.npc = (pc + 4 + ((op << 16) >> 14)) | 0;
        break;
      case 0x08: { // ADDI
        const a = L[rs], b = (op << 16) >> 16, r = (a + b) | 0;
        if (((a ^ r) & (b ^ r)) < 0) { this.exception(EXC_OV); break; }
        L[rt] = r; H[rt] = r >> 31;
        break;
      }
      case 0x09: { // ADDIU
        const r = (L[rs] + ((op << 16) >> 16)) | 0;
        L[rt] = r; H[rt] = r >> 31;
        break;
      }
      case 0x0a: { // SLTI
        const imm = (op << 16) >> 16, ih = imm >> 31;
        L[rt] = (H[rs] < ih || (H[rs] === ih && (L[rs] >>> 0) < (imm >>> 0))) ? 1 : 0; H[rt] = 0;
        break;
      }
      case 0x0b: { // SLTIU
        const imm = (op << 16) >> 16, ih = imm >> 31;
        L[rt] = ((H[rs] >>> 0) < (ih >>> 0) || (H[rs] === ih && (L[rs] >>> 0) < (imm >>> 0))) ? 1 : 0; H[rt] = 0;
        break;
      }
      case 0x0c: L[rt] = L[rs] & (op & 0xffff); H[rt] = 0; break; // ANDI
      case 0x0d: L[rt] = L[rs] | (op & 0xffff); H[rt] = H[rs]; break; // ORI
      case 0x0e: L[rt] = L[rs] ^ (op & 0xffff); H[rt] = H[rs]; break; // XORI
      case 0x0f: L[rt] = op << 16; H[rt] = L[rt] >> 31; break; // LUI
      case 0x10: this.cop0(op, pc, L, H); break;
      case 0x11: this.cop1(op, pc, L, H); break;
      case 0x12: this.copUnusable(2); break;
      case 0x13: this.cop1x(op, pc, L, H); break;
      case 0x14: // BEQL
        if (L[rs] === L[rt] && H[rs] === H[rt]) this.branch(pc + 4 + ((op << 16) >> 14));
        else { this.pc = this.npc; this.npc = (this.npc + 4) | 0; }
        break;
      case 0x15: // BNEL
        if (L[rs] !== L[rt] || H[rs] !== H[rt]) this.branch(pc + 4 + ((op << 16) >> 14));
        else { this.pc = this.npc; this.npc = (this.npc + 4) | 0; }
        break;
      case 0x16: // BLEZL
        if (H[rs] < 0 || (H[rs] === 0 && L[rs] === 0)) this.branch(pc + 4 + ((op << 16) >> 14));
        else { this.pc = this.npc; this.npc = (this.npc + 4) | 0; }
        break;
      case 0x17: // BGTZL
        if (H[rs] > 0 || (H[rs] === 0 && L[rs] !== 0)) this.branch(pc + 4 + ((op << 16) >> 14));
        else { this.pc = this.npc; this.npc = (this.npc + 4) | 0; }
        break;
      case 0x18: { // DADDI
        const imm = (op << 16) >> 16;
        const lo = (L[rs] >>> 0) + (imm >>> 0);
        const rl = lo | 0, rh = (H[rs] + (imm >> 31) + (lo > 0xffffffff ? 1 : 0)) | 0;
        const ih = imm >> 31;
        if (((H[rs] ^ rh) & (ih ^ rh)) < 0) { this.exception(EXC_OV); break; }
        L[rt] = rl; H[rt] = rh;
        break;
      }
      case 0x19: { // DADDIU
        const imm = (op << 16) >> 16;
        const lo = (L[rs] >>> 0) + (imm >>> 0);
        const h = (H[rs] + (imm >> 31) + (lo > 0xffffffff ? 1 : 0)) | 0;
        L[rt] = lo | 0; H[rt] = h;
        break;
      }
      case 0x1a: this.ldl(op, L, H, rs, rt); break;
      case 0x1b: this.ldr(op, L, H, rs, rt); break;
      case 0x1c: { // IDT: MAD/MADU/MUL
        const f = op & 0x3f;
        if (f === 0 || f === 1) {
          const hl = this.hiL, ll = this.loL;
          this.mult32(L[rs], L[rt], f === 0);
          const plo = this.loL >>> 0;
          const sumLo = plo + (ll >>> 0);
          const carry = sumLo > 0xffffffff ? 1 : 0;
          const lo = sumLo | 0;
          const hi = (this.hiL + hl + carry) | 0;
          this.loL = lo; this.loH = lo >> 31; this.hiL = hi; this.hiH = hi >> 31;
        } else if (f === 2) {
          const rd = (op >>> 11) & 31;
          const r = Math.imul(L[rs], L[rt]);
          L[rd] = r; H[rd] = r >> 31;
        } else this.unimpl(op, 'idt');
        break;
      }
      case 0x20: { const v = (this.rd8((L[rs] + ((op << 16) >> 16)) | 0) << 24) >> 24; L[rt] = v; H[rt] = v >> 31; break; } // LB
      case 0x21: { const v = (this.rd16((L[rs] + ((op << 16) >> 16)) | 0) << 16) >> 16; L[rt] = v; H[rt] = v >> 31; break; } // LH
      case 0x22: { // LWL
        const va = (L[rs] + ((op << 16) >> 16)) | 0;
        const w = this.rd32(va & ~3);
        const sh = (va & 3) * 8;
        const r = sh === 0 ? w : ((w << sh) | (L[rt] & ((1 << sh) - 1)));
        L[rt] = r; H[rt] = r >> 31;
        break;
      }
      case 0x23: { const v = this.rd32((L[rs] + ((op << 16) >> 16)) | 0); L[rt] = v; H[rt] = v >> 31; break; } // LW
      case 0x24: L[rt] = this.rd8((L[rs] + ((op << 16) >> 16)) | 0); H[rt] = 0; break; // LBU
      case 0x25: L[rt] = this.rd16((L[rs] + ((op << 16) >> 16)) | 0); H[rt] = 0; break; // LHU
      case 0x26: { // LWR
        const va = (L[rs] + ((op << 16) >> 16)) | 0;
        const w = this.rd32(va & ~3);
        const sh = (3 - (va & 3)) * 8;
        if (sh === 0) { L[rt] = w; H[rt] = w >> 31; }
        else { L[rt] = (w >>> sh) | (L[rt] & ~(0xffffffff >>> sh)); }
        break;
      }
      case 0x27: L[rt] = this.rd32((L[rs] + ((op << 16) >> 16)) | 0); H[rt] = 0; break; // LWU
      case 0x28: this.wr8((L[rs] + ((op << 16) >> 16)) | 0, L[rt]); break; // SB
      case 0x29: this.wr16((L[rs] + ((op << 16) >> 16)) | 0, L[rt]); break; // SH
      case 0x2a: { // SWL
        const va = (L[rs] + ((op << 16) >> 16)) | 0;
        const sh = (va & 3) * 8;
        if (sh === 0) { this.wr32(va, L[rt]); break; }
        const w = this.rd32(va & ~3);
        const mask = 0xffffffff >>> sh;
        this.wr32(va & ~3, (w & ~mask) | (L[rt] >>> sh));
        break;
      }
      case 0x2b: this.wr32((L[rs] + ((op << 16) >> 16)) | 0, L[rt]); break; // SW
      case 0x2c: this.sdl(op, L, H, rs, rt); break;
      case 0x2d: this.sdr(op, L, H, rs, rt); break;
      case 0x2e: { // SWR
        const va = (L[rs] + ((op << 16) >> 16)) | 0;
        const sh = (3 - (va & 3)) * 8;
        if (sh === 0) { this.wr32(va & ~3, L[rt]); break; }
        const w = this.rd32(va & ~3);
        const mask = (0xffffffff << sh);
        this.wr32(va & ~3, (w & ~mask) | (L[rt] << sh));
        break;
      }
      case 0x2f: // CACHE
        if (this.cacheHook) this.cacheHook(op, (L[rs] + ((op << 16) >> 16)) | 0);
        break;
      case 0x30: { // LL
        const v = this.rd32((L[rs] + ((op << 16) >> 16)) | 0);
        L[rt] = v; H[rt] = v >> 31; this.llbit = true;
        break;
      }
      case 0x31: { // LWC1
        if (!(this.cp0[C0_STATUS] & SR_CU1)) { this.copUnusable(1); break; }
        const v = this.rd32((L[rs] + ((op << 16) >> 16)) | 0);
        if (this.cp0[C0_STATUS] & SR_FR) this.fpr[rt] = v; else this.fpr[rt] = v;
        break;
      }
      case 0x34: { // LLD
        const va = (L[rs] + ((op << 16) >> 16)) | 0;
        if (va & 7) { this.exception(EXC_ADEL, va); break; }
        const hi = this.rd32(va), lo = this.rd32(va + 4);
        L[rt] = lo; H[rt] = hi; this.llbit = true;
        break;
      }
      case 0x35: { // LDC1
        if (!(this.cp0[C0_STATUS] & SR_CU1)) { this.copUnusable(1); break; }
        const va = (L[rs] + ((op << 16) >> 16)) | 0;
        if (va & 7) { this.exception(EXC_ADEL, va); break; }
        const hi = this.rd32(va), lo = this.rd32(va + 4);
        if (this.cp0[C0_STATUS] & SR_FR) { this.fpr[rt] = lo; this.fpr64H[rt] = hi; }
        else { this.fpr[rt & ~1] = lo; this.fpr[rt | 1] = hi; }
        break;
      }
      case 0x37: { // LD
        const va = (L[rs] + ((op << 16) >> 16)) | 0;
        if (va & 7) { this.exception(EXC_ADEL, va); break; }
        const hi = this.rd32(va), lo = this.rd32(va + 4);
        L[rt] = lo; H[rt] = hi;
        break;
      }
      case 0x38: { // SC
        const va = (L[rs] + ((op << 16) >> 16)) | 0;
        if (this.llbit) { this.wr32(va, L[rt]); L[rt] = 1; } else L[rt] = 0;
        H[rt] = 0;
        break;
      }
      case 0x39: { // SWC1
        if (!(this.cp0[C0_STATUS] & SR_CU1)) { this.copUnusable(1); break; }
        this.wr32((L[rs] + ((op << 16) >> 16)) | 0, this.fpr[rt]);
        break;
      }
      case 0x3c: { // SCD
        const va = (L[rs] + ((op << 16) >> 16)) | 0;
        if (va & 7) { this.exception(EXC_ADES, va); break; }
        if (this.llbit) { this.wr32(va, H[rt]); this.wr32(va + 4, L[rt]); L[rt] = 1; } else L[rt] = 0;
        H[rt] = 0;
        break;
      }
      case 0x3d: { // SDC1
        if (!(this.cp0[C0_STATUS] & SR_CU1)) { this.copUnusable(1); break; }
        const va = (L[rs] + ((op << 16) >> 16)) | 0;
        if (va & 7) { this.exception(EXC_ADES, va); break; }
        let lo, hi;
        if (this.cp0[C0_STATUS] & SR_FR) { lo = this.fpr[rt]; hi = this.fpr64H[rt]; }
        else { lo = this.fpr[rt & ~1]; hi = this.fpr[rt | 1]; }
        this.wr32(va, hi); this.wr32(va + 4, lo);
        break;
      }
      case 0x3f: { // SD
        const va = (L[rs] + ((op << 16) >> 16)) | 0;
        if (va & 7) { this.exception(EXC_ADES, va); break; }
        this.wr32(va, H[rt]); this.wr32(va + 4, L[rt]);
        break;
      }
      default:
        this.unimpl(op, 'opcode');
    }
  }

  // 64-bit value of register as two words; byte-wise helpers for LDL/LDR/SDL/SDR
  regByte(L, H, r, i) { // i = 0 (MSB) .. 7 (LSB)
    return i < 4 ? (H[r] >>> (24 - 8 * i)) & 0xff : (L[r] >>> (24 - 8 * (i - 4))) & 0xff;
  }
  setRegBytes(L, H, r, bytes) {
    H[r] = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    L[r] = (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  }
  ldl(op, L, H, rs, rt) {
    const va = (L[rs] + ((op << 16) >> 16)) | 0;
    const base = va & ~7, k = va & 7;
    const b = []; for (let i = 0; i < 8; i++) b.push(this.regByte(L, H, rt, i));
    for (let i = k; i < 8; i++) b[i - k] = this.rd8((base + i) | 0);
    this.setRegBytes(L, H, rt, b);
  }
  ldr(op, L, H, rs, rt) {
    const va = (L[rs] + ((op << 16) >> 16)) | 0;
    const base = va & ~7, k = va & 7;
    const b = []; for (let i = 0; i < 8; i++) b.push(this.regByte(L, H, rt, i));
    for (let i = 0; i <= k; i++) b[7 - k + i] = this.rd8((base + i) | 0);
    this.setRegBytes(L, H, rt, b);
  }
  sdl(op, L, H, rs, rt) {
    const va = (L[rs] + ((op << 16) >> 16)) | 0;
    const base = va & ~7, k = va & 7;
    for (let i = k; i < 8; i++) this.wr8((base + i) | 0, this.regByte(L, H, rt, i - k));
  }
  sdr(op, L, H, rs, rt) {
    const va = (L[rs] + ((op << 16) >> 16)) | 0;
    const base = va & ~7, k = va & 7;
    for (let i = 0; i <= k; i++) this.wr8((base + i) | 0, this.regByte(L, H, rt, 7 - k + i));
  }

  special(op, pc, L, H) {
    const rs = (op >>> 21) & 31, rt = (op >>> 16) & 31, rd = (op >>> 11) & 31, sa = (op >>> 6) & 31;
    switch (op & 0x3f) {
      case 0x00: { const r = L[rt] << sa; L[rd] = r; H[rd] = r >> 31; break; } // SLL
      case 0x01: { // MOVF/MOVT
        const cc = (op >>> 18) & 7, tf = (op >>> 16) & 1;
        if (this.fpuCC(cc) === (tf === 1)) { L[rd] = L[rs]; H[rd] = H[rs]; }
        break;
      }
      case 0x02: { const r = L[rt] >>> sa; L[rd] = r | 0; H[rd] = (r | 0) >> 31; break; } // SRL
      case 0x03: { const r = L[rt] >> sa; L[rd] = r; H[rd] = r >> 31; break; } // SRA
      case 0x04: { const r = L[rt] << (L[rs] & 31); L[rd] = r; H[rd] = r >> 31; break; } // SLLV
      case 0x06: { const r = (L[rt] >>> (L[rs] & 31)) | 0; L[rd] = r; H[rd] = r >> 31; break; } // SRLV
      case 0x07: { const r = L[rt] >> (L[rs] & 31); L[rd] = r; H[rd] = r >> 31; break; } // SRAV
      case 0x08: // JR
        this.branch(L[rs]);
        break;
      case 0x09: { // JALR
        const t = L[rs];
        L[rd] = (pc + 8) | 0; H[rd] = L[rd] >> 31;
        this.branch(t);
        break;
      }
      case 0x0a: if (L[rt] === 0 && H[rt] === 0) { L[rd] = L[rs]; H[rd] = H[rs]; } break; // MOVZ
      case 0x0b: if (L[rt] !== 0 || H[rt] !== 0) { L[rd] = L[rs]; H[rd] = H[rs]; } break; // MOVN
      case 0x0c: // SYSCALL
        this.exception(EXC_SYS);
        break;
      case 0x0d: // BREAK
        if (this.breakHook && this.breakHook(op, pc)) break;
        this.exception(EXC_BP);
        break;
      case 0x0f: break; // SYNC
      case 0x10: L[rd] = this.hiL; H[rd] = this.hiH; break; // MFHI
      case 0x11: this.hiL = L[rs]; this.hiH = H[rs]; break; // MTHI
      case 0x12: L[rd] = this.loL; H[rd] = this.loH; break; // MFLO
      case 0x13: this.loL = L[rs]; this.loH = H[rs]; break; // MTLO
      case 0x14: { // DSLLV
        const s = L[rs] & 63; this.dsll(L, H, rd, rt, s); break;
      }
      case 0x16: { const s = L[rs] & 63; this.dsrl(L, H, rd, rt, s); break; } // DSRLV
      case 0x17: { const s = L[rs] & 63; this.dsra(L, H, rd, rt, s); break; } // DSRAV
      case 0x18: this.mult32(L[rs], L[rt], true); break; // MULT
      case 0x19: this.mult32(L[rs], L[rt], false); break; // MULTU
      case 0x1a: { // DIV
        const a = L[rs], b = L[rt];
        if (b === 0) { this.loL = a < 0 ? 1 : -1; this.hiL = a; }
        else if (a === -2147483648 && b === -1) { this.loL = a; this.hiL = 0; }
        else { this.loL = (a / b) | 0; this.hiL = (a % b) | 0; }
        this.loH = this.loL >> 31; this.hiH = this.hiL >> 31;
        break;
      }
      case 0x1b: { // DIVU
        const a = L[rs] >>> 0, b = L[rt] >>> 0;
        if (b === 0) { this.loL = -1; this.hiL = a | 0; }
        else { this.loL = Math.floor(a / b) | 0; this.hiL = (a % b) | 0; }
        this.loH = this.loL >> 31; this.hiH = this.hiL >> 31;
        break;
      }
      case 0x1c: { // DMULT
        const p = this.big(rs) * this.big(rt);
        this.setBigLO(BigInt.asIntN(64, p)); this.setBigHI(BigInt.asIntN(64, p >> 64n));
        break;
      }
      case 0x1d: { // DMULTU
        const p = BigInt.asUintN(64, this.big(rs)) * BigInt.asUintN(64, this.big(rt));
        this.setBigLO(BigInt.asIntN(64, p)); this.setBigHI(BigInt.asIntN(64, p >> 64n));
        break;
      }
      case 0x1e: { // DDIV
        const a = this.big(rs), b = this.big(rt);
        if (b !== 0n) { this.setBigLO(BigInt.asIntN(64, a / b)); this.setBigHI(BigInt.asIntN(64, a % b)); }
        break;
      }
      case 0x1f: { // DDIVU
        const a = BigInt.asUintN(64, this.big(rs)), b = BigInt.asUintN(64, this.big(rt));
        if (b !== 0n) { this.setBigLO(BigInt.asIntN(64, a / b)); this.setBigHI(BigInt.asIntN(64, a % b)); }
        break;
      }
      case 0x20: { // ADD
        const a = L[rs], b = L[rt], r = (a + b) | 0;
        if (((a ^ r) & (b ^ r)) < 0) { this.exception(EXC_OV); break; }
        L[rd] = r; H[rd] = r >> 31;
        break;
      }
      case 0x21: { const r = (L[rs] + L[rt]) | 0; L[rd] = r; H[rd] = r >> 31; break; } // ADDU
      case 0x22: { // SUB
        const a = L[rs], b = L[rt], r = (a - b) | 0;
        if (((a ^ b) & (a ^ r)) < 0) { this.exception(EXC_OV); break; }
        L[rd] = r; H[rd] = r >> 31;
        break;
      }
      case 0x23: { const r = (L[rs] - L[rt]) | 0; L[rd] = r; H[rd] = r >> 31; break; } // SUBU
      case 0x24: L[rd] = L[rs] & L[rt]; H[rd] = H[rs] & H[rt]; break; // AND
      case 0x25: L[rd] = L[rs] | L[rt]; H[rd] = H[rs] | H[rt]; break; // OR
      case 0x26: L[rd] = L[rs] ^ L[rt]; H[rd] = H[rs] ^ H[rt]; break; // XOR
      case 0x27: L[rd] = ~(L[rs] | L[rt]); H[rd] = ~(H[rs] | H[rt]); break; // NOR
      case 0x2a: // SLT
        L[rd] = (H[rs] < H[rt] || (H[rs] === H[rt] && (L[rs] >>> 0) < (L[rt] >>> 0))) ? 1 : 0; H[rd] = 0;
        break;
      case 0x2b: // SLTU
        L[rd] = ((H[rs] >>> 0) < (H[rt] >>> 0) || (H[rs] === H[rt] && (L[rs] >>> 0) < (L[rt] >>> 0))) ? 1 : 0; H[rd] = 0;
        break;
      case 0x2c: case 0x2d: { // DADD / DADDU
        const lo = (L[rs] >>> 0) + (L[rt] >>> 0);
        const rh = (H[rs] + H[rt] + (lo > 0xffffffff ? 1 : 0)) | 0;
        if ((op & 0x3f) === 0x2c && ((H[rs] ^ rh) & (H[rt] ^ rh)) < 0) { this.exception(EXC_OV); break; }
        L[rd] = lo | 0; H[rd] = rh;
        break;
      }
      case 0x2e: case 0x2f: { // DSUB / DSUBU
        const lo = (L[rs] >>> 0) - (L[rt] >>> 0);
        const rh = (H[rs] - H[rt] - (lo < 0 ? 1 : 0)) | 0;
        if ((op & 0x3f) === 0x2e && ((H[rs] ^ H[rt]) & (H[rs] ^ rh)) < 0) { this.exception(EXC_OV); break; }
        L[rd] = lo | 0; H[rd] = rh;
        break;
      }
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x36: { // TGE TGEU TLT TLTU TEQ TNE
        const f = op & 0x3f;
        const a = this.big(rs), b = this.big(rt);
        const ua = BigInt.asUintN(64, a), ub = BigInt.asUintN(64, b);
        let t = false;
        if (f === 0x30) t = a >= b; else if (f === 0x31) t = ua >= ub;
        else if (f === 0x32) t = a < b; else if (f === 0x33) t = ua < ub;
        else if (f === 0x34) t = a === b; else t = a !== b;
        if (t) this.exception(EXC_TR);
        break;
      }
      case 0x38: this.dsll(L, H, rd, rt, sa); break; // DSLL
      case 0x3a: this.dsrl(L, H, rd, rt, sa); break; // DSRL
      case 0x3b: this.dsra(L, H, rd, rt, sa); break; // DSRA
      case 0x3c: this.dsll(L, H, rd, rt, sa + 32); break; // DSLL32
      case 0x3e: this.dsrl(L, H, rd, rt, sa + 32); break; // DSRL32
      case 0x3f: this.dsra(L, H, rd, rt, sa + 32); break; // DSRA32
      default:
        this.unimpl(op, 'special');
    }
  }

  dsll(L, H, rd, rt, s) {
    const lo = L[rt], hi = H[rt];
    if (s === 0) { L[rd] = lo; H[rd] = hi; }
    else if (s < 32) { H[rd] = (hi << s) | (lo >>> (32 - s)); L[rd] = lo << s; }
    else { H[rd] = lo << (s - 32); L[rd] = 0; }
  }
  dsrl(L, H, rd, rt, s) {
    const lo = L[rt], hi = H[rt];
    if (s === 0) { L[rd] = lo; H[rd] = hi; }
    else if (s < 32) { L[rd] = (lo >>> s) | (hi << (32 - s)); H[rd] = hi >>> s; }
    else { L[rd] = hi >>> (s - 32); H[rd] = 0; }
  }
  dsra(L, H, rd, rt, s) {
    const lo = L[rt], hi = H[rt];
    if (s === 0) { L[rd] = lo; H[rd] = hi; }
    else if (s < 32) { L[rd] = (lo >>> s) | (hi << (32 - s)); H[rd] = hi >> s; }
    else { L[rd] = hi >> (s - 32); H[rd] = hi >> 31; }
  }

  regimm(op, pc, L, H) {
    const rs = (op >>> 21) & 31;
    const target = (pc + 4 + ((op << 16) >> 14)) | 0;
    const neg = H[rs] < 0;
    switch ((op >>> 16) & 31) {
      case 0x00: this.nextIsDelay = true; if (neg) this.npc = target; break; // BLTZ
      case 0x01: this.nextIsDelay = true; if (!neg) this.npc = target; break; // BGEZ
      case 0x02: if (neg) this.branch(target); else { this.pc = this.npc; this.npc = (this.npc + 4) | 0; } break; // BLTZL
      case 0x03: if (!neg) this.branch(target); else { this.pc = this.npc; this.npc = (this.npc + 4) | 0; } break; // BGEZL
      case 0x10: L[31] = (pc + 8) | 0; H[31] = L[31] >> 31; this.nextIsDelay = true; if (neg) this.npc = target; break; // BLTZAL
      case 0x11: L[31] = (pc + 8) | 0; H[31] = L[31] >> 31; this.nextIsDelay = true; if (!neg) this.npc = target; break; // BGEZAL
      case 0x12: L[31] = (pc + 8) | 0; H[31] = L[31] >> 31; if (neg) this.branch(target); else { this.pc = this.npc; this.npc = (this.npc + 4) | 0; } break;
      case 0x13: L[31] = (pc + 8) | 0; H[31] = L[31] >> 31; if (!neg) this.branch(target); else { this.pc = this.npc; this.npc = (this.npc + 4) | 0; } break;
      case 0x08: case 0x09: case 0x0a: case 0x0b: case 0x0c: case 0x0e: { // trap immediates
        const imm = BigInt((op << 16) >> 16);
        const a = this.big(rs);
        const ua = BigInt.asUintN(64, a), ui = BigInt.asUintN(64, imm);
        const f = (op >>> 16) & 31;
        let t = false;
        if (f === 0x08) t = a >= imm; else if (f === 0x09) t = ua >= ui;
        else if (f === 0x0a) t = a < imm; else if (f === 0x0b) t = ua < ui;
        else if (f === 0x0c) t = a === imm; else t = a !== imm;
        if (t) this.exception(EXC_TR);
        break;
      }
      default: this.unimpl(op, 'regimm');
    }
  }

  // ---------------------------------------------------------------- COP0

  readCp0(r) {
    switch (r) {
      case C0_COUNT: return this.getCount();
      case C0_CAUSE: return this.updateCause();
      default: return this.cp0[r];
    }
  }

  writeCp0(r, v) {
    switch (r) {
      case C0_COUNT: this.setCount(v); break;
      case C0_COMPARE: this.cp0[r] = v; this.timerIrq = false; break;
      case C0_CAUSE: this.cp0[r] = (this.cp0[r] & ~0x00800300) | (v & 0x00800300); break; // IV + soft ints
      case C0_PRID: break;
      case C0_STATUS: {
        const old = this.cp0[r];
        this.cp0[r] = v;
        if (((old ^ v) & 0x02000000) && this.log) this.log('[cpu] RE bit changed');
        break;
      }
      default: this.cp0[r] = v;
    }
  }

  cop0(op, pc, L, H) {
    const sr = this.cp0[C0_STATUS];
    if ((sr & SR_KSU) && !(sr & (SR_EXL | SR_ERL)) && !(sr & 0x10000000)) { this.copUnusable(0); return; }
    const rt = (op >>> 16) & 31, rd = (op >>> 11) & 31;
    switch ((op >>> 21) & 31) {
      case 0x00: { const v = this.readCp0(rd); L[rt] = v; H[rt] = v >> 31; break; } // MFC0
      case 0x01: { const v = this.readCp0(rd); L[rt] = v; H[rt] = v >> 31; break; } // DMFC0
      case 0x04: this.writeCp0(rd, L[rt]); break; // MTC0
      case 0x05: this.writeCp0(rd, L[rt]); break; // DMTC0
      case 0x08: { // BC0x - treat CpCond as false
        const tf = (op >>> 16) & 3;
        const target = (pc + 4 + ((op << 16) >> 14)) | 0;
        const cond = false;
        if (tf === 0) { this.nextIsDelay = true; if (!cond) this.npc = target; }
        else if (tf === 1) { this.nextIsDelay = true; if (cond) this.npc = target; }
        else if (tf === 2) { if (!cond) this.branch(target); else { this.pc = this.npc; this.npc = (this.npc + 4) | 0; } }
        else { if (cond) this.branch(target); else { this.pc = this.npc; this.npc = (this.npc + 4) | 0; } }
        break;
      }
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16: case 0x17:
      case 0x18: case 0x19: case 0x1a: case 0x1b: case 0x1c: case 0x1d: case 0x1e: case 0x1f:
        switch (op & 0x3f) {
          case 0x01: case 0x02: case 0x06: case 0x08: break; // TLBR/TLBWI/TLBWR/TLBP: no TLB on R4640
          case 0x18: { // ERET
            if (sr & SR_ERL) { this.pc = this.cp0[C0_ERROREPC]; this.cp0[C0_STATUS] = sr & ~SR_ERL; }
            else { this.pc = this.cp0[C0_EPC]; this.cp0[C0_STATUS] = sr & ~SR_EXL; }
            this.npc = (this.pc + 4) | 0;
            this.llbit = false;
            this.nextIsDelay = false;
            break;
          }
          case 0x20: break; // WAIT (not on R4640 but harmless)
          default: this.unimpl(op, 'cop0');
        }
        break;
      default: this.unimpl(op, 'cop0');
    }
  }

  // ---------------------------------------------------------------- COP1 (FPU)

  cop1(op, pc, L, H) {
    if (!(this.cp0[C0_STATUS] & SR_CU1)) { this.copUnusable(1); return; }
    const fmt = (op >>> 21) & 31, ft = (op >>> 16) & 31, fs = (op >>> 11) & 31, fd = (op >>> 6) & 31;
    const FR = (this.cp0[C0_STATUS] & SR_FR) !== 0;
    switch (fmt) {
      case 0x00: { const v = this.fpr[fs]; L[ft] = v; H[ft] = v >> 31; return; } // MFC1
      case 0x01: { // DMFC1
        if (FR) { L[ft] = this.fpr[fs]; H[ft] = this.fpr64H[fs]; }
        else { L[ft] = this.fpr[fs & ~1]; H[ft] = this.fpr[fs | 1]; }
        return;
      }
      case 0x02: { // CFC1
        const v = fs === 31 ? this.fcr31 : (fs === 0 ? 0x2200 : 0);
        L[ft] = v; H[ft] = v >> 31; return;
      }
      case 0x04: this.fpr[fs] = L[ft]; return; // MTC1
      case 0x05: // DMTC1
        if (FR) { this.fpr[fs] = L[ft]; this.fpr64H[fs] = H[ft]; }
        else { this.fpr[fs & ~1] = L[ft]; this.fpr[fs | 1] = H[ft]; }
        return;
      case 0x06: if (fs === 31) this.fcr31 = L[ft] & 0x0183ffff; return; // CTC1
      case 0x08: { // BC1F/BC1T/BC1FL/BC1TL
        const cc = (op >>> 18) & 7, nd = (op >>> 17) & 1, tf = (op >>> 16) & 1;
        const cond = this.fpuCC(cc) === (tf === 1);
        const target = (pc + 4 + ((op << 16) >> 14)) | 0;
        if (!nd) { this.nextIsDelay = true; if (cond) this.npc = target; }
        else if (cond) this.branch(target);
        else { this.pc = this.npc; this.npc = (this.npc + 4) | 0; }
        return;
      }
    }
    const f = op & 0x3f;
    if (fmt === 0x10 || fmt === 0x11) {
      const S = fmt === 0x10;
      const get = S ? (r) => this.fprS(r) : (r) => this.fprD(r);
      const set = S ? (r, v) => this.setS(r, v) : (r, v) => this.setD(r, v);
      switch (f) {
        case 0x00: set(fd, get(fs) + get(ft)); return;
        case 0x01: set(fd, get(fs) - get(ft)); return;
        case 0x02: set(fd, get(fs) * get(ft)); return;
        case 0x03: set(fd, get(fs) / get(ft)); return;
        case 0x04: set(fd, Math.sqrt(get(fs))); return;
        case 0x05: set(fd, Math.abs(get(fs))); return;
        case 0x06: // MOV
          if (S) this.fpr[fd] = this.fpr[fs];
          else if (FR) { this.fpr[fd] = this.fpr[fs]; this.fpr64H[fd] = this.fpr64H[fs]; }
          else { this.fpr[fd & ~1] = this.fpr[fs & ~1]; this.fpr[fd | 1] = this.fpr[fs | 1]; }
          return;
        case 0x07: set(fd, -get(fs)); return;
        case 0x08: this.setL(fd, Math.round(get(fs))); return; // ROUND.L (approx)
        case 0x09: this.setL(fd, Math.trunc(get(fs))); return;
        case 0x0a: this.setL(fd, Math.ceil(get(fs))); return;
        case 0x0b: this.setL(fd, Math.floor(get(fs))); return;
        case 0x0c: { const v = get(fs), fl = Math.floor(v), d = v - fl; // ROUND.W (nearest even)
          this.fpr[fd] = this.toW(d > 0.5 ? fl + 1 : d < 0.5 ? fl : (fl % 2 === 0 ? fl : fl + 1)); return; }
        case 0x0d: this.fpr[fd] = this.toW(Math.trunc(get(fs))); return;
        case 0x0e: this.fpr[fd] = this.toW(Math.ceil(get(fs))); return;
        case 0x0f: this.fpr[fd] = this.toW(Math.floor(get(fs))); return;
        case 0x11: { // MOVF/MOVT.fmt
          const cc = (op >>> 18) & 7, tf = (op >>> 16) & 1;
          if (this.fpuCC(cc) === (tf === 1)) set(fd, get(fs));
          return;
        }
        case 0x12: if (L[ft] === 0 && H[ft] === 0) set(fd, get(fs)); return; // MOVZ.fmt
        case 0x13: if (L[ft] !== 0 || H[ft] !== 0) set(fd, get(fs)); return; // MOVN.fmt
        case 0x20: this.setS(fd, get(fs)); return; // CVT.S
        case 0x21: this.setD(fd, get(fs)); return; // CVT.D
        case 0x24: this.fpr[fd] = this.toW(this.roundMode(get(fs))); return; // CVT.W
        case 0x25: this.setL(fd, this.roundMode(get(fs))); return; // CVT.L
      }
      if (f >= 0x30) {
        const a = get(fs), b = get(ft);
        const un = Number.isNaN(a) || Number.isNaN(b);
        const c = f & 0xf;
        let r = false;
        if (c & 1) r = r || un;
        if (c & 2) r = r || (!un && a === b);
        if (c & 4) r = r || (!un && a < b);
        this.fpuCond((op >>> 8) & 7, r);
        return;
      }
    } else if (fmt === 0x14) { // W
      const v = this.fpr[fs];
      if (f === 0x20) { this.setS(fd, v); return; }
      if (f === 0x21) { this.setD(fd, v); return; }
    } else if (fmt === 0x15) { // L
      const v = this.fprL(fs);
      if (f === 0x20) { this.setS(fd, v); return; }
      if (f === 0x21) { this.setD(fd, v); return; }
    }
    this.unimpl(op, 'cop1');
  }

  cop1x(op, pc, L, H) {
    if (!(this.cp0[C0_STATUS] & SR_CU1)) { this.copUnusable(1); return; }
    this.unimpl(op, 'cop1x');
  }
}

export const CP0 = { C0_IBASE, C0_IBOUND, C0_DBASE, C0_DBOUND, C0_BADVADDR, C0_COUNT, C0_COMPARE,
  C0_STATUS, C0_CAUSE, C0_EPC, C0_PRID, C0_CONFIG, C0_CALG, C0_IWATCH, C0_DWATCH, C0_ECC,
  C0_CACHEERR, C0_TAGLO, C0_TAGHI, C0_ERROREPC };
