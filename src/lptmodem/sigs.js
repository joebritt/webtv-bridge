// Signatures for the routines the LPT patch touches, so that a build without symbols.sym can be
// patched too. Learned from the builds that have symbols (tools/lptsigs.mjs writes
// sigdb.json); recoverSymbols() then finds the same names in a bare image and hands patch.js
// a symbol source.
//
// A signature is a function's body (start to the next symbol) with the fields that move from
// build to build masked out:
//   - j / jal targets (kept as references: the target's name);
//   - kseg0 addresses built with lui 0x80xx + a low half (addiu, ori, loads, stores; kept as
//     references: the data or function named there, plus offset);
//   - words that are addresses inside the build's code (jump tables).
// Everything else (registers, branch offsets, constants, hardware addresses) must match.
//
// Recovery:
//   1. every variant of every function is searched for in one pass over the code, keyed on
//      one exact word of it (its "anchor");
//   2. a function found at one place is located; one found at several (small functions) is
//      settled by where its neighbours are, from the distances seen in the learned builds;
//   3. the references inside located functions name more: data (the modem rings,
//      gCharIOSelect) and the functions they call. A name must get one answer from all of
//      them, or it stays unknown.
// The result says how each name was found; patch.js refuses as usual if something it needs is
// missing.

import { startsAfter } from './patch.js';

export const SIGDB_VERSION = 1;

const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const hex = (v) => (v >>> 0).toString(16).padStart(8, '0');
const MAX_WORDS = 1024;                  // longest body learned
const CLASS = 'ParallelDriver';          // its members are learned as "ParallelDriver::<name>"

// loads, stores and the ALU ops that take a %lo (daddiu: the hand-written modem handler)
const LO_OPS = new Set([0x09, 0x0d, 0x19, 0x1a, 0x1b, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b,
  0x2c, 0x2d, 0x2e, 0x31, 0x35, 0x37, 0x39, 0x3d, 0x3f]);
const isLoad = (op) => (op >= 0x20 && op <= 0x27) || op === 0x1a || op === 0x1b || op === 0x31 || op === 0x35 || op === 0x37;

// the register an instruction writes, or -1
function dest(w) {
  const op = w >>> 26;
  if (op === 0) { const f = w & 0x3f; return f === 8 || f === 0x0c || f === 0x0d || f === 0x18 || f === 0x19 || f === 0x1a || f === 0x1b ? (f === 9 ? (w >>> 11) & 31 : -1) : (w >>> 11) & 31; }
  if (op === 3) return 31;
  if (op === 2 || op === 1 || (op >= 4 && op <= 7) || (op >= 0x14 && op <= 0x17) || (op >= 0x28 && op <= 0x2f) || op >= 0x38) return -1;
  if (op === 0x10 || op === 0x11) return (w >>> 21 & 31) === 0 ? (w >>> 16) & 31 : -1; // mfc0 / mfc1
  return (w >>> 16) & 31;
}

// Mask a body. -> { masks, sites: [{ i, kind: 'j' | 'lo' | 'abs', hi?: index of the lui }] }.
// `inCode(a)`: a is an address in the build's code (jump table entries).
// Which register holds a lui 0x80xx is followed along the control flow (branch targets get
// what any path into them has; calls clobber the caller-saved registers), since compilers
// share one lui between paths.
const CALLER_SAVED = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 24, 25, 31];
const isBranch = (w) => { const op = w >>> 26; return op === 1 || (op >= 4 && op <= 7) || (op >= 0x14 && op <= 0x17); };
const branchTarget = (w, i) => i + 1 + ((w << 16) >> 16);
const isJr = (w) => (w >>> 26) === 0 && ((w & 0x3f) === 8);
const isUncondBranch = (w) => (w >>> 16) === 0x1000 || (w >>> 16) === 0x0411; // b / bal
export function maskBody(words, inCode, start = 0) {
  const n = words.length;
  const masks = new Array(n).fill(0xffffffff);
  const siteAt = new Array(n).fill(null);
  const state = new Array(n).fill(null); // hi state on entry: Int32Array(32) of lui indexes
  const fixed = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const w = words[i], op = w >>> 26;
    if (inCode(w)) { masks[i] = 0; siteAt[i] = { i, kind: 'abs' }; fixed[i] = true; }
    else if (op === 2 || op === 3) { masks[i] = 0xfc000000; siteAt[i] = { i, kind: 'j' }; }
  }
  const work = [];
  const enter = (i, st) => {
    if (i < 0 || i >= n) return;
    const cur = state[i];
    if (!cur) { state[i] = Int32Array.from(st); work.push(i); return; }
    let changed = false;
    for (let r = 0; r < 32; r++) if (cur[r] < 0 && st[r] >= 0) { cur[r] = st[r]; changed = true; }
    if (changed) work.push(i);
  };
  let steps = 0;
  // code reached only through a jump table (or not at all) starts fresh
  for (let seed = 0; seed < n; seed++) {
    if (state[seed] || fixed[seed]) continue;
    enter(seed, new Int32Array(32).fill(-1));
  while (work.length && steps++ < n * 40) {
    const i = work.pop();
    if (fixed[i]) continue; // data (a jump table) isn't executed
    const st = Int32Array.from(state[i]), w = words[i], op = w >>> 26;
    const rs = (w >>> 21) & 31, rt = (w >>> 16) & 31;
    if (op === 0x0f) {
      const imm = w & 0xffff;
      if (imm >= 0x8000 && imm < 0x8100) { masks[i] = 0xffff0000; st[rt] = i; } else st[rt] = -1;
    } else if (LO_OPS.has(op) && rs !== 0 && st[rs] >= 0) {
      masks[i] = 0xffff0000;
      siteAt[i] = { i, kind: 'lo', hi: st[rs] };
      if (op === 0x09 || op === 0x0d || op === 0x19 || isLoad(op)) st[rt] = -1;
    } else if (op === 3 || (op === 0 && (w & 0x3f) === 9)) {
      for (const r of CALLER_SAVED) st[r] = -1;
    } else if (op === 0 && [0x20, 0x21, 0x2c, 0x2d].includes(w & 0x3f) && (st[rs] >= 0) !== (st[rt] >= 0)) {
      st[(w >>> 11) & 31] = st[rs] >= 0 ? st[rs] : st[rt]; // hi + an index: still the hi half
    } else {
      const d = dest(w);
      if (d > 0) st[d] = -1;
    }
    // successors (a branch's delay slot runs first, then the target)
    if (isBranch(w) || op === 2 || isJr(w)) {
      const slot = i + 1;
      if (slot < n && !fixed[slot]) {
        // run the delay slot with this state, then continue from it
        const s2 = Int32Array.from(st), ws = words[slot], ops = ws >>> 26;
        if (ops === 0x0f) { const imm = ws & 0xffff; if (imm >= 0x8000 && imm < 0x8100) { masks[slot] = 0xffff0000; s2[(ws >>> 16) & 31] = slot; } else s2[(ws >>> 16) & 31] = -1; }
        else if (LO_OPS.has(ops) && ((ws >>> 21) & 31) !== 0 && s2[(ws >>> 21) & 31] >= 0) {
          masks[slot] = 0xffff0000; siteAt[slot] = { i: slot, kind: 'lo', hi: s2[(ws >>> 21) & 31] };
          if (ops === 0x09 || ops === 0x0d || ops === 0x19 || isLoad(ops)) s2[(ws >>> 16) & 31] = -1;
        } else { const d = dest(ws); if (d > 0) s2[d] = -1; }
        if (isBranch(w)) {
          enter(branchTarget(w, i), s2);
          if (!isUncondBranch(w)) enter(i + 2, s2);
        } else if (op === 2 && start) {
          // a jump inside the body is followed; out of it (a tail call), not
          const t = ((((start + i * 4 + 4) & 0xf0000000) | ((w & 0x3ffffff) << 2)) >>> 0) - start;
          if (t >= 0 && (t >> 2) < n) enter(t >> 2, s2);
        }
      }
      continue;
    }
    if (op === 3 || (op === 0 && (w & 0x3f) === 9)) { // call: its delay slot, then on
      const slot = i + 1;
      if (slot < n) {
        const s2 = Int32Array.from(state[i]), ws = words[slot], ops = ws >>> 26;
        if (LO_OPS.has(ops) && ((ws >>> 21) & 31) !== 0 && s2[(ws >>> 21) & 31] >= 0) { masks[slot] = 0xffff0000; siteAt[slot] = { i: slot, kind: 'lo', hi: s2[(ws >>> 21) & 31] }; }
        else if (ops === 0x0f) { const imm = ws & 0xffff; if (imm >= 0x8000 && imm < 0x8100) masks[slot] = 0xffff0000; }
        enter(i + 2, st);
      }
      continue;
    }
    enter(i + 1, st);
  }
  }
  // a lone lui 0x80xx that nothing uses as an address stays masked: the hi half of an address
  const sites = siteAt.filter(Boolean);
  return { masks, sites };
}

// the address a masked site points at, in `words` (as the code at `at` has them)
function siteTarget(s, words, at) {
  const w = words[s.i];
  if (s.kind === 'abs') return w >>> 0;
  if (s.kind === 'j') return ((((at + s.i * 4) + 4) & 0xf0000000) | ((w & 0x3ffffff) << 2)) >>> 0;
  const hi = (words[s.hi] & 0xffff) << 16, op = w >>> 26;
  const lo = op === 0x0d ? w & 0xffff : (w << 16) >> 16;
  return (hi + lo) >>> 0;
}

// ---------------------------------------------------------------- learning

// From one build with symbols. S: patch.js symbolSource; names: the functions (and data, which
// only appears as references) the patch uses. -> { fns: { name: { start, words, masks, sites,
// refs } }, order: [[addr, name]] (every learned function, for neighbour distances) }
export function learnBuild(img, info, S, names, dataNames = []) {
  const base = info.base, codeEnd = base + info.codeSize;
  const inCode = (a) => a >= base && a < codeEnd;
  const want = new Set(names);
  // reference naming: the symbol at or below an address, if it is one we want
  const syms = S.list.filter(([, n]) => want.has(n) || n.startsWith(`${CLASS}::`)).sort((x, y) => x[0] - y[0]);
  const allSorted = S.list.slice().sort((x, y) => x[0] - y[0]);
  const named = (a) => {
    // the closest symbol of any kind at or below a; a reference only counts if that is one we want
    let lo = 0, hi = allSorted.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (allSorted[mid][0] <= a) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    if (best < 0) return null;
    const at = allSorted[best][0];
    // several names at one address: the one we want
    for (let j = best; j >= 0 && allSorted[j][0] === at; j--) if (want.has(allSorted[j][1])) return { name: allSorted[j][1], off: a - at };
    return null;
  };
  const fns = {};
  const learn = (name, start, end) => {
    if (!inCode(start) || end <= start) return;
    const n = Math.min((end - start) >> 2, MAX_WORDS);
    const words = Array.from({ length: n }, (_, i) => be32(img, start - base + i * 4));
    const { masks, sites } = maskBody(words, inCode, start);
    const refs = [];
    for (const s of sites) {
      const t = siteTarget(s, words, start);
      if (s.kind === 'abs' || (s.kind === 'j' && t >= start && t < start + n * 4)) continue; // inside itself
      const r = named(t);
      if (r && r.name !== name) refs.push({ ...s, name: r.name, off: r.off });
    }
    fns[name] = { start, words, masks, sites, refs };
  };
  for (const name of names) if (S.has(name) && inCode(S.addr(name))) learn(name, S.addr(name), S.end(name));
  const members = S.members(CLASS);
  members.forEach((m, k) => learn(`${CLASS}::${k === 0 ? CLASS : memberName(m.name)}`, m.start, m.end));
  const order = Object.entries(fns).map(([n, f]) => [f.start, n]).sort((x, y) => x[0] - y[0]);
  // data (anything wanted outside the code): where it is, for offsets between data names
  const data = {};
  for (const name of dataNames) if (S.has(name) && !inCode(S.addr(name))) data[name] = S.addr(name);
  return { fns, order, data };
}

// "FPutChar" / "PPutChar" (class index byte + name) or "ParallelDriver::PutChar" -> "PutChar"
function memberName(n) { return n.startsWith(`${CLASS}::`) ? n.slice(CLASS.length + 2) : n.slice(1); }

// Merge learned builds into a database: per function, its distinct variants (masked words +
// references), and for neighbour distances, the offsets to the nearest learned functions.
// learned: [{ id, fns, order }]
export function buildDb(learned) {
  const fns = {};
  // data names: offsets to each other, kept where every build that has both agrees
  const rel = {};
  for (const { id, data } of learned) {
    for (const [a, x] of Object.entries(data || {})) for (const [b, y] of Object.entries(data)) {
      if (a === b) continue;
      const r = (rel[a] || (rel[a] = {}))[b] || (rel[a][b] = { d: new Set(), ids: [] });
      r.d.add(x - y); r.ids.push(id);
    }
  }
  for (const { id, fns: f, order } of learned) {
    for (const [name, x] of Object.entries(f)) {
      const masked = x.words.map((w, i) => (w & x.masks[i]) >>> 0);
      const key = masked.join(',') + '|' + x.masks.join(',');
      const e = fns[name] || (fns[name] = { variants: new Map(), near: {} });
      let v = e.variants.get(key);
      if (!v) e.variants.set(key, v = { words: masked, masks: x.masks, refs: x.refs.map(({ i, kind, hi, name: n, off }) => ({ i, kind, hi, name: n, off })), builds: [] });
      v.builds.push(id);
      // distances to the two learned functions on either side
      const k = order.findIndex(([, n]) => n === name);
      for (const j of [k - 2, k - 1, k + 1, k + 2]) {
        if (j < 0 || j >= order.length) continue;
        const [a, n] = order[j];
        (e.near[n] || (e.near[n] = [])).push({ d: x.start - a, id });
      }
    }
  }
  const out = { version: SIGDB_VERSION, fns: {}, data: {} };
  for (const [name, e] of Object.entries(fns)) out.fns[name] = { variants: [...e.variants.values()], near: e.near };
  for (const [a, m] of Object.entries(rel)) for (const [b, r] of Object.entries(m)) {
    if (r.d.size === 1 && r.ids.length >= 3) (out.data[a] || (out.data[a] = {}))[b] = { d: [...r.d][0], ids: r.ids };
  }
  return out;
}

// the database without what only some builds taught it (leave-one-out tests)
export function withoutBuilds(db, ids) {
  const drop = new Set(ids);
  const out = { version: db.version, fns: {}, data: {} };
  for (const [a, m] of Object.entries(db.data || {})) for (const [b, r] of Object.entries(m)) {
    const ids = r.ids.filter((x) => !drop.has(x));
    if (ids.length) (out.data[a] || (out.data[a] = {}))[b] = { d: r.d, ids };
  }
  for (const [name, e] of Object.entries(db.fns)) {
    const variants = e.variants.map((v) => ({ ...v, builds: v.builds.filter((b) => !drop.has(b)) })).filter((v) => v.builds.length);
    const near = {};
    for (const [n, ds] of Object.entries(e.near)) { const k = ds.filter((x) => !drop.has(x.id)); if (k.length) near[n] = k; }
    if (variants.length) out.fns[name] = { variants, near };
  }
  return out;
}

// compact form for sigdb.json: words and masks as hex strings, build ids dropped to counts
export function packDb(db) {
  const fns = {};
  for (const [name, e] of Object.entries(db.fns)) {
    const near = {};
    for (const [n, ds] of Object.entries(e.near)) near[n] = [...new Set(ds.map((x) => x.d))];
    fns[name] = {
      variants: e.variants.map((v) => ({ w: v.words.map(hex).join(''), m: v.masks.map(hex).join(''), refs: v.refs.map((r) => [r.i, r.kind, r.hi ?? -1, r.name, r.off]), n: v.builds.length })),
      near,
    };
  }
  const data = {};
  for (const [a, m] of Object.entries(db.data || {})) for (const [b, r] of Object.entries(m)) (data[a] || (data[a] = {}))[b] = r.d;
  return { version: db.version, fns, data };
}

export function unpackDb(p) {
  if (p.version !== SIGDB_VERSION) throw new Error(`signature database version ${p.version}, expected ${SIGDB_VERSION}`);
  const words = (s) => Array.from({ length: s.length / 8 }, (_, i) => parseInt(s.slice(i * 8, i * 8 + 8), 16) >>> 0);
  const fns = {};
  for (const [name, e] of Object.entries(p.fns)) {
    const near = {};
    for (const [n, ds] of Object.entries(e.near)) near[n] = ds.map((d) => ({ d }));
    fns[name] = {
      variants: e.variants.map((v) => ({ words: words(v.w), masks: words(v.m), refs: v.refs.map(([i, kind, hi, name, off]) => ({ i, kind, hi: hi < 0 ? undefined : hi, name, off })), builds: Array(v.n).fill(0) })),
      near,
    };
  }
  const data = {};
  for (const [a, m] of Object.entries(p.data || {})) for (const [b, d] of Object.entries(m)) (data[a] || (data[a] = {}))[b] = { d, ids: [] };
  return { version: p.version, fns, data };
}

// ---------------------------------------------------------------- recovery

const COMMON = new Set([0x00000000, 0x03e00008, 0x27bdffe8, 0x27bdffe0, 0xafbf0010, 0xafbf0014, 0xafbf0018, 0x8fbf0010,
  0x8fbf0014, 0x8fbf0018, 0x27bd0018, 0x27bd0020, 0xafb00010, 0x8fb00010, 0x00000821]);

// img: an approm image; info: osImageInfo(img). -> a symbol source for patch.js, plus
// `how` (name -> 'signature' | 'neighbours' | 'reference') and `report` lines
export function recoverSymbols(img, info, db) {
  const base = info.base, codeEnd = base + info.codeSize, n = info.codeSize >> 2;
  const W = new Uint32Array(n);
  for (let i = 0; i < n; i++) W[i] = be32(img, i * 4);
  const report = [];

  // 1. one pass over the code, keyed on each variant's anchor word
  const anchors = new Map(); // word -> [[name, variant, k]]
  for (const [name, e] of Object.entries(db.fns)) {
    for (const v of e.variants) {
      let k = -1;
      for (let i = 0; i < v.words.length; i++) if (v.masks[i] === 0xffffffff && !COMMON.has(v.words[i])) { k = i; break; }
      if (k < 0) for (let i = 0; i < v.words.length; i++) if (v.masks[i] === 0xffffffff) { k = i; break; }
      if (k < 0) continue;
      const w = v.words[k];
      if (!anchors.has(w)) anchors.set(w, []);
      anchors.get(w).push([name, v, k]);
    }
  }
  const found = new Map(); // name -> Map(addr -> variant)
  for (let p = 0; p < n; p++) {
    const list = anchors.get(W[p]);
    if (!list) continue;
    for (const [name, v, k] of list) {
      const s = p - k;
      if (s < 0 || s + v.words.length > n) continue;
      let ok = true;
      for (let i = 0; i < v.words.length; i++) if (((W[s + i] & v.masks[i]) >>> 0) !== v.words[i]) { ok = false; break; }
      if (!ok) continue;
      if (!found.has(name)) found.set(name, new Map());
      const at = base + s * 4;
      if (!found.get(name).has(at) || found.get(name).get(at).words.length < v.words.length) found.get(name).set(at, v);
    }
  }

  // 2. unique matches, then the ambiguous ones: first by what they call (a candidate whose
  // calls go elsewhere than the located callees is out), then by their neighbours
  const loc = new Map(); // name -> { addr, len (words) | null, how, v }
  for (const [name, m] of found) if (m.size === 1) { const [[a, v]] = [...m]; loc.set(name, { addr: a, len: v.words.length, how: 'signature', v }); }
  const callsAgree = (a, v) => {
    const words = Array.from(W.subarray((a - base) >> 2, ((a - base) >> 2) + v.words.length));
    let known = 0;
    for (const r of v.refs) {
      if (r.kind !== 'j' || !loc.has(r.name)) continue;
      if ((siteTarget(r, words, a) - r.off) >>> 0 !== loc.get(r.name).addr) return -1;
      known++;
    }
    return known;
  };
  const startsFunction = (p) => p < 2 || startsAfter(W[p - 2], W[p - 1]);
  const refVotes = () => { // name -> Map(addr -> count), from the references in located functions
    const votes = new Map();
    for (const [, l] of loc) {
      if (!l.v) continue;
      const words = Array.from(W.subarray((l.addr - base) >> 2, ((l.addr - base) >> 2) + l.v.words.length));
      for (const r of l.v.refs) {
        const t = (siteTarget(r, words, l.addr) - r.off) >>> 0;
        if (!votes.has(r.name)) votes.set(r.name, new Map());
        const m = votes.get(r.name);
        m.set(t, (m.get(t) || 0) + 1);
      }
    }
    return votes;
  };
  const conflicts = [];
  for (let pass = 0, changed = true; changed && pass < 8; pass++) {
    changed = false;
    for (const [name, m] of found) {
      if (loc.has(name) || m.size < 2) continue;
      const fit = [...m].filter(([a, v]) => callsAgree(a, v) > 0);
      if (fit.length === 1) { const [[a, v]] = fit; loc.set(name, { addr: a, len: v.words.length, how: 'calls', v }); changed = true; continue; }
      const near = db.fns[name].near;
      const votes = new Map();
      for (const [other, ds] of Object.entries(near)) {
        const o = loc.get(other);
        if (!o || !o.len) continue;
        for (const { d } of ds) { const want = o.addr + d; if (m.has(want) && callsAgree(want, m.get(want)) >= 0) votes.set(want, (votes.get(want) || 0) + 1); }
      }
      // one address, or a clear plurality (learned distances differ between builds, and a
      // two-word function matches in many places)
      const ranked = [...votes].sort((x, y) => y[1] - x[1]);
      if (ranked.length && (ranked.length === 1 || (ranked[0][1] >= 2 && ranked[0][1] > ranked[1][1]))) {
        const a = ranked[0][0];
        loc.set(name, { addr: a, len: m.get(a).words.length, how: 'neighbours', v: m.get(a) }); changed = true;
      }
    }
    // near matches, where neighbours say a function should be: a few constants may differ
    // (16406's InitModem loads interrupt 0x16 where the others load 0x14)
    for (const [name, e] of Object.entries(db.fns)) {
      if (loc.has(name) || found.get(name)?.size > 1) continue;
      const cands = new Map(); // addr -> { v, bad }
      for (const [other, ds] of Object.entries(e.near)) {
        const o = loc.get(other);
        if (!o || !o.len) continue;
        for (const { d } of ds) {
          const at = o.addr + d, p = (at - base) >> 2;
          if (at < base || p + 8 > n || !startsFunction(p)) continue;
          for (const v of e.variants) {
            if (v.words.length < 8 || p + v.words.length > n) continue;
            let bad = 0;
            for (let i = 0; i < v.words.length && bad <= 4; i++) if (((W[p + i] & v.masks[i]) >>> 0) !== v.words[i]) bad++;
            if (bad <= Math.min(4, v.words.length >> 3) && (!cands.has(at) || cands.get(at).bad > bad)) cands.set(at, { v, bad });
          }
        }
      }
      if (cands.size === 1) { const [[a2, { v }]] = [...cands]; loc.set(name, { addr: a2, len: v.words.length, how: 'near match' }); changed = true; }
    }
    // 3. references from located functions name the rest
    for (const [name, m] of refVotes()) {
      if (loc.has(name) || m.size !== 1) continue;
      const [[a]] = [...m];
      const v = found.get(name)?.get(a);
      loc.set(name, { addr: a, len: v ? v.words.length : null, how: 'reference', v });
      changed = true;
    }
  }
  // every reference must agree with what was located
  for (const [name, m] of refVotes()) {
    const l = loc.get(name);
    if (l) { if (!m.has(l.addr) || m.size > 1) conflicts.push(`${name}: found at ${hex(l.addr)} but referenced as ${[...m.keys()].map(hex).join(', ')}`); }
    else conflicts.push(`${name}: referenced as ${[...m.keys()].map(hex).join(', ')}`);
  }
  // data nobody references: at a fixed offset from data that is located (where every learned
  // build agrees on that offset)
  for (let pass = 0; pass < 2; pass++) {
    for (const [name, m] of Object.entries(db.data || {})) {
      if (loc.has(name)) continue;
      const votes = new Set();
      for (const [other, r] of Object.entries(m)) if (loc.has(other) && loc.get(other).how === 'reference') votes.add((loc.get(other).addr + r.d) >>> 0);
      if (votes.size === 1) loc.set(name, { addr: [...votes][0], len: null, how: 'data layout' });
      else if (votes.size > 1) conflicts.push(`${name}: data layout gives ${[...votes].map(hex).join(', ')}`);
    }
  }
  for (const c of conflicts) report.push(`signature conflict, ${c}`);
  // a conflicting name is not trusted
  for (const c of conflicts) loc.delete(c.split(':')[0]);

  // ---- the symbol source
  const inCode = (a) => a >= base && a < codeEnd;
  const fnEnd = (l) => {
    if (l.len) return l.addr + l.len * 4;
    // found only by reference: up to the first return (a lower bound on its real end)
    for (let p = l.addr; p < Math.min(codeEnd, l.addr + 0x1000); p += 4) if (W[(p - base) >> 2] === 0x03e00008) return p + 8;
    return l.addr + 8;
  };
  const err = (m) => { const e = new Error(m); e.name = 'PatchError'; return e; };
  const has = (name) => loc.has(name);
  const addr = (name) => { if (!loc.has(name)) throw err(`${name} not found by signature (no learned build has it, or it matched ambiguously)`); return loc.get(name).addr; };
  const end = (name) => fnEnd(loc.get(name) || { addr: addr(name) });
  const members = (cls) => {
    if (cls !== CLASS) return [];
    const ctor = loc.get(`${CLASS}::${CLASS}`);
    if (!ctor || !ctor.len) return [];
    const ms = [...loc].filter(([nm, l]) => nm.startsWith(`${CLASS}::`) && nm !== `${CLASS}::${CLASS}` && l.len && inCode(l.addr))
      .map(([nm, l]) => ({ name: nm, start: l.addr, end: fnEnd(l) })).sort((x, y) => x.start - y.start);
    return [{ name: `${CLASS}::${CLASS}`, start: ctor.addr, end: fnEnd(ctor) }, ...ms];
  };
  const how = Object.fromEntries([...loc].map(([nm, l]) => [nm, l.how]));
  const counts = {};
  for (const h of Object.values(how)) counts[h] = (counts[h] || 0) + 1;
  report.unshift(`symbols recovered from signatures: ${Object.entries(counts).map(([h, c]) => `${c} by ${h}`).join(', ')}`);
  return { kind: 'signatures', has, addr, end, members, how, report, list: [...loc].map(([nm, l]) => [l.addr, nm]).sort((x, y) => x[0] - y[0]) };
}
