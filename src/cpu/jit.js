// Basic-block translator: compiles runs of MIPS instructions into JavaScript functions.
//
// A block runs from its entry PC up to and including the first branch/jump and its delay
// slot (or until an instruction we don't translate). Blocks are only used in kernel mode,
// where virtual -> physical translation is just `va & 0x1fffffff`, and are keyed by
// virtual PC. Writes to RAM pages that hold translated code invalidate those blocks.
//
// Generated functions take (cpu, L, H, ram) and must leave cpu.pc/npc pointing at the next
// instruction. Anything that can raise an exception sets cpu.curPC/cpu.inDelay first; an
// exception either throws (memory faults) or sets cpu.excTaken, after which the block
// returns immediately (cpu.exception() has already redirected pc).

const MAX_BLOCK = 128;

// Tiering: a block is only compiled once it has been entered HOT_THRESHOLD times; until then
// lookup() returns COLD and the CPU interprets it. Much code (startup, page layout) runs only
// a handful of times, and compiling it costs more than interpreting it.
export const COLD = Object.freeze({ cold: true });
export let HOT_THRESHOLD = 1024;
export function setHotThreshold(n) { HOT_THRESHOLD = n; }
export let SUPERBLOCKS = true;
export function setSuperblocks(on) { SUPERBLOCKS = on; }

const hex = (v) => '0x' + (v >>> 0).toString(16);

export class Jit {
  constructor(cpu) {
    this.cpu = cpu;
    this.blocks = new Map(); // pc -> fn
    this.heat = new Map();   // pc -> times entered while not yet compiled
    this.pageBlocks = new Map(); // physical page -> Set(pc)
    this.codePages = new Uint8Array(1 << 17); // 4KB pages of the 512MB physical space
    this.compiled = 0;
    this.invalidations = 0;
  }

  lookup(pc) {
    let fn = this.blocks.get(pc);
    if (fn === undefined) {
      const h = (this.heat.get(pc) || 0) + 1;
      if (h < HOT_THRESHOLD) { this.heat.set(pc, h); return COLD; }
      this.heat.delete(pc);
      fn = this.compile(pc);
      this.blocks.set(pc, fn);
    }
    return fn;
  }

  invalidatePage(page) {
    const set = this.pageBlocks.get(page);
    if (set) {
      for (const pc of set) {
        const fn = this.blocks.get(pc);
        if (fn) fn.dead = true; // breaks chained references from other blocks
        this.blocks.delete(pc);
      }
      this.pageBlocks.delete(page);
      this.invalidations++;
    }
    this.codePages[page] = 0;
  }

  flush() {
    for (const fn of this.blocks.values()) if (fn) fn.dead = true;
    this.blocks.clear();
    this.pageBlocks.clear();
    this.codePages.fill(0);
  }

  // Returns a compiled function, or null if the first instruction can't be translated.
  compile(pc) {
    const cpu = this.cpu;
    const lines = [];
    let p = pc;
    let n = 0;
    let ended = false;
    const pages = new Set();
    const read = (va) => {
      const pa = va & 0x1fffffff;
      pages.add(pa >>> 12);
      return cpu.fetch(va) | 0;
    };
    while (n < MAX_BLOCK && !ended) {
      const op = read(p);
      const kind = classify(op);
      if (kind === BRANCH) {
        const slotOp = read(p + 4);
        if (classify(slotOp) !== SIMPLE && classify(slotOp) !== FALLBACK) break; // branch in delay slot: interpret
        const slot = emitSimple(slotOp, p + 4, true);
        // Superblock: a conditional branch exits only when taken; the not-taken path keeps
        // going in the same function. Exits give back the cycles of the instructions they
        // skip (the dispatcher charges fn.len up front), patched in once the length is known.
        if (SUPERBLOCKS && n + 2 < MAX_BLOCK - 2 && classify(read(p + 8)) !== STOP) {
          const exit = emitBranchExit(op, p, slot, `cpu.cycles-=@@${n + 2}@@;`);
          if (exit !== null) {
            lines.push(exit);
            n += 2;
            p = (p + 8) | 0;
            continue;
          }
        }
        const code = emitBranch(op, p, slot);
        if (code === null) break;
        lines.push(code);
        n += 2;
        ended = true;
        break;
      }
      if (kind === STOP) break;
      // mfc0 (Count): the block's cycles are charged on entry, and early exits give back the
      // ones they skip, so time read mid-block would run ahead and then backwards. Read it at
      // this instruction's own cycle, as the interpreter does.
      if (op >>> 26 === 0x10 && ((op >>> 21) & 31) === 0) lines.push(`cpu.cycles-=@@${n + 1}@@;${emitSimple(op, p, false)}cpu.cycles+=@@${n + 1}@@;`);
      else lines.push(emitSimple(op, p, false));
      n++;
      p = (p + 4) | 0;
      if (kind === FALLBACK_END) { ended = true; lines.push(`cpu.pc=${hex(p)}|0;cpu.npc=${hex(p + 4)}|0;`); break; }
    }
    if (n === 0) return null;
    if (!ended) lines.push(`cpu.pc=${hex(p)}|0;cpu.npc=${hex(p + 4)}|0;`);
    const src = `"use strict";\n${lines.join('\n')}`.replace(/@@(\d+)@@/g, (_, k) => String(n - Number(k)));
    let fn;
    try {
      fn = new Function('cpu', 'L', 'H', 'ram', src);
    } catch (e) {
      console.error('jit compile error at', hex(pc), e, src);
      return null;
    }
    fn.len = n;
    fn.dead = false;
    fn.nxPc = 0; fn.nxFn = null; // last successor (block chaining)
    for (const pg of pages) {
      this.codePages[pg] = 1;
      let set = this.pageBlocks.get(pg);
      if (!set) { set = new Set(); this.pageBlocks.set(pg, set); }
      set.add(pc);
    }
    this.compiled++;
    return fn;
  }
}

// ---------------------------------------------------------------- classification

const SIMPLE = 0, FALLBACK = 1, FALLBACK_END = 2, BRANCH = 3, STOP = 4;

function classify(op) {
  const o = op >>> 26;
  switch (o) {
    case 0x00: {
      const f = op & 0x3f;
      if (f === 0x08 || f === 0x09) return BRANCH;
      if (f === 0x0c || f === 0x0d) return STOP; // syscall/break
      return SIMPLE;
    }
    case 0x01: {
      const rt = (op >>> 16) & 31;
      return (rt <= 3 || (rt >= 0x10 && rt <= 0x13)) ? BRANCH : FALLBACK;
    }
    case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x07:
    case 0x14: case 0x15: case 0x16: case 0x17:
      return BRANCH;
    case 0x10: { // COP0
      const rs = (op >>> 21) & 31;
      if (rs === 0 || rs === 1) return FALLBACK;
      if (rs === 4 || rs === 5) return FALLBACK_END; // mtc0 may unmask interrupts / change mode
      return STOP; // eret, bc0, tlb ops
    }
    case 0x11: { // COP1
      const rs = (op >>> 21) & 31;
      return rs === 8 ? STOP : FALLBACK;
    }
    case 0x12: case 0x13: return STOP;
    default: return SIMPLE;
  }
}

// ---------------------------------------------------------------- emitters

function guard(pc, delay) { return `cpu.curPC=${hex(pc)}|0;cpu.inDelay=${delay};`; }

function fallback(op, pc, delay) {
  return `${guard(pc, delay)}cpu.excTaken=false;cpu.execute(${hex(op)}|0,${hex(pc)}|0,L,H);L[0]=0;H[0]=0;if(cpu.excTaken)return;`;
}

const setW = (r, expr) => r === 0 ? `${expr};` : `L[${r}]=${expr};H[${r}]=L[${r}]>>31;`;

function addr(rs, imm) { return imm === 0 ? `L[${rs}]` : `(L[${rs}]+${imm})|0`; }

function load(op, pc, delay, kind) {
  const rs = (op >>> 21) & 31, rt = (op >>> 16) & 31, imm = (op << 16) >> 16;
  const g = guard(pc, delay);
  // fast path: RAM, naturally aligned
  const fast = {
    lw: [`(va&3)===0`, `ram[(pa&cpu.ramMask)>>>2]`, `cpu.rd32(va)`],
    lwu: [`(va&3)===0`, `ram[(pa&cpu.ramMask)>>>2]`, `cpu.rd32(va)`],
    lb: [`true`, `(ram[(pa&cpu.ramMask)>>>2]<<((pa&3)<<3))>>24`, `(cpu.rd8(va)<<24)>>24`],
    lbu: [`true`, `(ram[(pa&cpu.ramMask)>>>2]>>>((3-(pa&3))<<3))&0xff`, `cpu.rd8(va)`],
    lh: [`(va&1)===0`, `(ram[(pa&cpu.ramMask)>>>2]<<((pa&2)<<3))>>16`, `(cpu.rd16(va)<<16)>>16`],
    lhu: [`(va&1)===0`, `(ram[(pa&cpu.ramMask)>>>2]>>>((2-(pa&2))<<3))&0xffff`, `cpu.rd16(va)`],
  }[kind];
  const tgt = rt === 0 ? 'v' : `L[${rt}]`;
  const hi = rt === 0 ? '' : (kind === 'lwu' || kind === 'lbu' || kind === 'lhu') ? `H[${rt}]=0;` : `H[${rt}]=L[${rt}]>>31;`;
  return `{const va=${addr(rs, imm)};const pa=va&0x1fffffff;let v;if(pa<0x4000000&&${fast[0]})v=${fast[1]};else{${g}v=${fast[2]};}${rt === 0 ? '' : `${tgt}=v;${hi}`}}`;
}

function store(op, pc, delay, kind) {
  const rs = (op >>> 21) & 31, rt = (op >>> 16) & 31, imm = (op << 16) >> 16;
  const g = guard(pc, delay);
  const inval = `if(cpu.jit.codePages[pa>>>12])cpu.jit.invalidatePage(pa>>>12);`;
  let fast, slow;
  if (kind === 'sw') {
    fast = [`(va&3)===0`, `ram[(pa&cpu.ramMask)>>>2]=L[${rt}];`];
    slow = `cpu.wr32(va,L[${rt}]);`;
  } else if (kind === 'sh') {
    fast = [`(va&1)===0`, `{const i=(pa&cpu.ramMask)>>>2,s=(2-(pa&2))<<3;ram[i]=(ram[i]&~(0xffff<<s))|((L[${rt}]&0xffff)<<s);}`];
    slow = `cpu.wr16(va,L[${rt}]);`;
  } else {
    fast = [`true`, `{const i=(pa&cpu.ramMask)>>>2,s=(3-(pa&3))<<3;ram[i]=(ram[i]&~(0xff<<s))|((L[${rt}]&0xff)<<s);}`];
    slow = `cpu.wr8(va,L[${rt}]);`;
  }
  return `{const va=${addr(rs, imm)};const pa=va&0x1fffffff;if(pa<0x4000000&&${fast[0]}){${fast[1]}${inval}}else{${g}${slow}${inval}}}`;
}

function emitSimple(op, pc, delay) {
  const rs = (op >>> 21) & 31, rt = (op >>> 16) & 31, rd = (op >>> 11) & 31, sa = (op >>> 6) & 31;
  const imm = (op << 16) >> 16, uimm = op & 0xffff;
  const o = op >>> 26;
  if (op === 0) return '';
  switch (o) {
    case 0x00:
      switch (op & 0x3f) {
        case 0x00: return setW(rd, `L[${rt}]<<${sa}`);
        case 0x02: return setW(rd, `(L[${rt}]>>>${sa})|0`);
        case 0x03: return setW(rd, `L[${rt}]>>${sa}`);
        case 0x04: return setW(rd, `L[${rt}]<<(L[${rs}]&31)`);
        case 0x06: return setW(rd, `(L[${rt}]>>>(L[${rs}]&31))|0`);
        case 0x07: return setW(rd, `L[${rt}]>>(L[${rs}]&31)`);
        case 0x0a: return rd === 0 ? '' : `if(L[${rt}]===0&&H[${rt}]===0){L[${rd}]=L[${rs}];H[${rd}]=H[${rs}];}`;
        case 0x0b: return rd === 0 ? '' : `if(L[${rt}]!==0||H[${rt}]!==0){L[${rd}]=L[${rs}];H[${rd}]=H[${rs}];}`;
        case 0x0f: return '';
        case 0x10: return rd === 0 ? '' : `L[${rd}]=cpu.hiL;H[${rd}]=cpu.hiH;`;
        case 0x11: return `cpu.hiL=L[${rs}];cpu.hiH=H[${rs}];`;
        case 0x12: return rd === 0 ? '' : `L[${rd}]=cpu.loL;H[${rd}]=cpu.loH;`;
        case 0x13: return `cpu.loL=L[${rs}];cpu.loH=H[${rs}];`;
        case 0x18: return `cpu.mult32(L[${rs}],L[${rt}],true);`;
        case 0x19: return `cpu.mult32(L[${rs}],L[${rt}],false);`;
        case 0x21: return setW(rd, `(L[${rs}]+L[${rt}])|0`);
        case 0x23: return setW(rd, `(L[${rs}]-L[${rt}])|0`);
        case 0x24: return rd === 0 ? '' : `L[${rd}]=L[${rs}]&L[${rt}];H[${rd}]=H[${rs}]&H[${rt}];`;
        case 0x25: return rd === 0 ? '' : `L[${rd}]=L[${rs}]|L[${rt}];H[${rd}]=H[${rs}]|H[${rt}];`;
        case 0x26: return rd === 0 ? '' : `L[${rd}]=L[${rs}]^L[${rt}];H[${rd}]=H[${rs}]^H[${rt}];`;
        case 0x27: return rd === 0 ? '' : `L[${rd}]=~(L[${rs}]|L[${rt}]);H[${rd}]=~(H[${rs}]|H[${rt}]);`;
        case 0x2a: return rd === 0 ? '' : `L[${rd}]=(H[${rs}]<H[${rt}]||(H[${rs}]===H[${rt}]&&(L[${rs}]>>>0)<(L[${rt}]>>>0)))?1:0;H[${rd}]=0;`;
        case 0x2b: return rd === 0 ? '' : `L[${rd}]=((H[${rs}]>>>0)<(H[${rt}]>>>0)||(H[${rs}]===H[${rt}]&&(L[${rs}]>>>0)<(L[${rt}]>>>0)))?1:0;H[${rd}]=0;`;
        case 0x2d: return rd === 0 ? '' : `{const lo=(L[${rs}]>>>0)+(L[${rt}]>>>0);H[${rd}]=(H[${rs}]+H[${rt}]+(lo>0xffffffff?1:0))|0;L[${rd}]=lo|0;}`;
      }
      return fallback(op, pc, delay);
    case 0x09: return setW(rt, `(L[${rs}]+${imm})|0`);
    case 0x0a: {
      const ih = imm >> 31;
      return rt === 0 ? '' : `L[${rt}]=(H[${rs}]<${ih}||(H[${rs}]===${ih}&&(L[${rs}]>>>0)<${imm >>> 0}))?1:0;H[${rt}]=0;`;
    }
    case 0x0b: {
      const ih = imm >> 31;
      return rt === 0 ? '' : `L[${rt}]=((H[${rs}]>>>0)<${ih >>> 0}||(H[${rs}]===${ih}&&(L[${rs}]>>>0)<${imm >>> 0}))?1:0;H[${rt}]=0;`;
    }
    case 0x0c: return rt === 0 ? '' : `L[${rt}]=L[${rs}]&${uimm};H[${rt}]=0;`;
    case 0x0d: return rt === 0 ? '' : `L[${rt}]=L[${rs}]|${uimm};H[${rt}]=H[${rs}];`;
    case 0x0e: return rt === 0 ? '' : `L[${rt}]=L[${rs}]^${uimm};H[${rt}]=H[${rs}];`;
    case 0x0f: return rt === 0 ? '' : `L[${rt}]=${(op << 16) | 0};H[${rt}]=${((op << 16) | 0) >> 31};`;
    case 0x19: return rt === 0 ? '' : `{const lo=(L[${rs}]>>>0)+${imm >>> 0};H[${rt}]=(H[${rs}]+${imm >> 31}+(lo>0xffffffff?1:0))|0;L[${rt}]=lo|0;}`;
    case 0x1c:
      if ((op & 0x3f) === 2) return setW(rd, `Math.imul(L[${rs}],L[${rt}])`);
      return fallback(op, pc, delay);
    case 0x20: return load(op, pc, delay, 'lb');
    case 0x21: return load(op, pc, delay, 'lh');
    case 0x23: return load(op, pc, delay, 'lw');
    case 0x24: return load(op, pc, delay, 'lbu');
    case 0x25: return load(op, pc, delay, 'lhu');
    case 0x27: return load(op, pc, delay, 'lwu');
    case 0x28: return store(op, pc, delay, 'sb');
    case 0x29: return store(op, pc, delay, 'sh');
    case 0x2b: return store(op, pc, delay, 'sw');
    case 0x2f: return ''; // CACHE
  }
  // Stores via the interpreter still need code invalidation; the bus handles that.
  return fallback(op, pc, delay);
}

// Emit a branch/jump together with its delay slot. Returns null if unsupported.
// A conditional branch in the middle of a superblock: if taken, run the slot, set pc and
// return (after `exitCode`); if not, fall through to the code that follows (likely branches
// skip their slot). Returns null for jumps and anything else that always leaves the block.
function emitBranchExit(op, pc, slot, exitCode) {
  const rs = (op >>> 21) & 31, rt = (op >>> 16) & 31;
  const o = op >>> 26;
  const tgt = (pc + 4 + (((op << 16) >> 16) << 2)) | 0;
  const go = `cpu.pc=${hex(tgt)}|0;cpu.npc=${hex(tgt + 4)}|0;${exitCode}return;`;
  const cond = (c) => `{const t=${c};${slot}if(t){${go}}}`;
  const likely = (c) => `if(${c}){${slot}${go}}`;
  const eq = `(L[${rs}]===L[${rt}]&&H[${rs}]===H[${rt}])`;
  const lez = `(H[${rs}]<0||(H[${rs}]===0&&L[${rs}]===0))`;
  const gtz = `(H[${rs}]>0||(H[${rs}]===0&&L[${rs}]!==0))`;
  switch (o) {
    case 0x01:
      switch (rt) {
        case 0x00: return cond(`(H[${rs}]<0)`);
        case 0x01: return cond(`(H[${rs}]>=0)`);
        case 0x02: return likely(`(H[${rs}]<0)`);
        case 0x03: return likely(`(H[${rs}]>=0)`);
      }
      return null; // the linking forms (BLTZAL etc.) end the block
    case 0x04: return cond(eq);
    case 0x05: return cond(`!${eq}`);
    case 0x06: return cond(lez);
    case 0x07: return cond(gtz);
    case 0x14: return likely(eq);
    case 0x15: return likely(`!${eq}`);
    case 0x16: return likely(lez);
    case 0x17: return likely(gtz);
  }
  return null;
}

function emitBranch(op, pc, slot) {
  const rs = (op >>> 21) & 31, rt = (op >>> 16) & 31, rd = (op >>> 11) & 31;
  const o = op >>> 26;
  const tgt = (pc + 4 + (((op << 16) >> 16) << 2)) | 0;
  const fall = (pc + 8) | 0;
  const done = (t) => `cpu.pc=${t};cpu.npc=(cpu.pc+4)|0;`;
  const cond = (c) => `{const t=${c};${slot}${done(`t?${hex(tgt)}|0:${hex(fall)}|0`)}}`;
  const likely = (c) => `if(${c}){${slot}${done(`${hex(tgt)}|0`)}}else{${done(`${hex(fall)}|0`)}}`;
  const link = (r) => r === 0 ? '' : `L[${r}]=${hex(fall)}|0;H[${r}]=L[${r}]>>31;`;
  const eq = `(L[${rs}]===L[${rt}]&&H[${rs}]===H[${rt}])`;
  const lez = `(H[${rs}]<0||(H[${rs}]===0&&L[${rs}]===0))`;
  const gtz = `(H[${rs}]>0||(H[${rs}]===0&&L[${rs}]!==0))`;
  switch (o) {
    case 0x00:
      if ((op & 0x3f) === 0x08) return `{const t=L[${rs}];${slot}${done('t')}}`;
      return `{const t=L[${rs}];${link(rd)}${slot}${done('t')}}`; // JALR
    case 0x01: {
      const neg = `(H[${rs}]<0)`, pos = `(H[${rs}]>=0)`;
      switch (rt) {
        case 0x00: return cond(neg);
        case 0x01: return cond(pos);
        case 0x02: return likely(neg);
        case 0x03: return likely(pos);
        case 0x10: return `{const t=${neg};${link(31)}${slot}${done(`t?${hex(tgt)}|0:${hex(fall)}|0`)}}`;
        case 0x11: return `{const t=${pos};${link(31)}${slot}${done(`t?${hex(tgt)}|0:${hex(fall)}|0`)}}`;
        case 0x12: return `{const t=${neg};${link(31)}if(t){${slot}${done(`${hex(tgt)}|0`)}}else{${done(`${hex(fall)}|0`)}}}`;
        case 0x13: return `{const t=${pos};${link(31)}if(t){${slot}${done(`${hex(tgt)}|0`)}}else{${done(`${hex(fall)}|0`)}}}`;
      }
      return null;
    }
    case 0x02: case 0x03: {
      const t = (((pc + 4) & 0xf0000000) | ((op & 0x03ffffff) << 2)) | 0;
      return `${o === 3 ? link(31) : ''}${slot}${done(`${hex(t)}|0`)}`;
    }
    case 0x04: return cond(eq);
    case 0x05: return cond(`!${eq}`);
    case 0x06: return cond(lez);
    case 0x07: return cond(gtz);
    case 0x14: return likely(eq);
    case 0x15: return likely(`!${eq}`);
    case 0x16: return likely(lez);
    case 0x17: return likely(gtz);
  }
  return null;
}
