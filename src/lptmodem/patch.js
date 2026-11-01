// Patch a WebTV OS build (an approm image with its symbols.sym) to use the LPT modem bridge
// instead of the hardware modem, and to keep the OS's own code off the parallel port.
// Everything is located by symbol name, so any build whose modem driver has the usual
// shape can be patched; anything unexpected is refused with a reason.
//
//   import { patchLptModem, parseSymbols } from './patch.js';
//   const { image, report } = patchLptModem(approm, symbolsSym);
//
// What it does (see WEBTV_LPT_BRIDGE.md §6):
//   - assembles driver.js and places its functions in the bodies of the functions it
//     replaces, then points each replaced entry at its replacement (j + nop);
//   - moves Enable/DisableModemInterrupts and ModemReset to the parallel port interrupt;
//   - InitParallelPort returns "no printer", so the printer driver never touches the port
//     (its methods become "return -1" stubs and their bodies more room for the driver);
//   - debug builds: the parallel debug console becomes the bridge's console channel;
//   - recomputes the build checksum.

import { parse, prepare, unitSize, unitLabels, assemble, evaluate } from './asm.js';
import { V as PMV } from './parmod.js';
import { driverSource, consoleSource, rebootSource, DRIVER_VERSION, SIGNATURE } from './driver.js';
import { parmodSource } from './parmod.js';
import { osImageInfo } from '../machine/osinstall.js';

export class PatchError extends Error {}

const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const put32 = (b, o, v) => { b[o] = v >>> 24; b[o + 1] = v >>> 16; b[o + 2] = v >>> 8; b[o + 3] = v; };
const hex = (v) => (v >>> 0).toString(16).padStart(8, '0');

// symbols.sym comes in two formats:
//   - 16-byte header, then [u32 BE address][NUL-terminated name]... (1999+ builds). C++ members
//     carry a one-byte class index in front of the member name; a non-letter prefix is dropped.
//   - "TIMN" + u32, then [u32 BE address][u8 length][name]... (1998 builds), full C++ names.
export function parseSymbols(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const byName = new Map(), list = [];
  const add = (addr, name) => {
    if (!name) return;
    list.push([addr, name]);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(addr);
  };
  const str = (o, e) => { let s = ''; for (let i = o; i < e; i++) s += String.fromCharCode(b[i]); return s; };
  if (b[0] === 0x54 && b[1] === 0x49 && b[2] === 0x4d && b[3] === 0x4e) {
    for (let o = 8; o + 5 <= b.length;) {
      const addr = be32(b, o), n = b[o + 4];
      add(addr, str(o + 5, Math.min(b.length, o + 5 + n)));
      o += 5 + n;
    }
  } else {
    for (let o = 16; o + 4 < b.length;) {
      const addr = be32(b, o); o += 4;
      let e = o; while (e < b.length && b[e]) e++;
      add(addr, str(o, e).replace(/^[^A-Za-z_]+/, ''));
      o = e + 1;
    }
  }
  list.sort((x, y) => x[0] - y[0]);
  return { byName, list };
}

// ---------------------------------------------------------------- where things are
// The patcher asks a symbol source rather than symbols.sym itself, so a build without symbols
// can be patched from names recovered out of its code (sigs.js):
//   has(n)          n is known, at one address
//   addr(n)         its address (PatchError if unknown or ambiguous)
//   end(n)          where the function at n ends (the next symbol)
//   members(cls)    the class's member functions, constructor first: [{ name, start, end }]
//                   (symbols.sym stores them contiguously, after the constructor)
export function symbolSource(symBytes, img) {
  const info = osImageInfo(img);
  const codeEnd = info.base + info.codeSize;
  const { byName, list } = parseSymbols(symBytes);
  // A function can only start where the code before it has ended one: a jr, j, b or break in
  // the last two words, or padding. Other symbols in the code point into the middle of a
  // function (16423 has CodeName, MinorVersion, Name, Version inside ParallelDriver::InitDevice)
  // and don't end the one they are in.
  const word = (a) => be32(img, a - info.base);
  const inCodeRange = (a) => a >= info.base && a < codeEnd;
  const realStart = (a) => !inCodeRange(a) || a - 8 < info.base || startsAfter(word(a - 8), word(a - 4));
  const starts = [...new Set(list.map(([a]) => a))].filter(realStart).sort((x, y) => x - y);
  const nextSym = (a) => { // first symbol above a
    let lo = 0, hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= a) lo = mid + 1; else hi = mid; }
    return lo < starts.length ? starts[lo] : codeEnd;
  };
  const has = (n) => byName.has(n) && new Set(byName.get(n)).size === 1;
  const addr = (n) => {
    const a = byName.get(n);
    if (!a) throw new PatchError(`symbol ${n} not found (not a build this patch understands)`);
    if (new Set(a).size > 1) throw new PatchError(`symbol ${n} is ambiguous`);
    return a[0];
  };
  const inCode = (a) => a >= info.base && a < codeEnd;
  // member symbols are the class index byte + name (1999+), or "Class::name" (TIMN files).
  // A group of other symbols at one address (data among the methods: 16423 has CodeName,
  // MinorVersion, Name, Version) is stepped over when members follow it; the method before
  // it still ends there.
  const members = (cls) => {
    const i0 = list.findIndex(([a, n]) => (n === `${cls}::${cls}` || (n.length === cls.length + 1 && n.endsWith(cls))) && inCode(a));
    if (i0 < 0) return [];
    const n0 = list[i0][1], prefix = n0.startsWith(`${cls}::`) ? `${cls}::` : n0[0];
    const out = [];
    for (let i = i0; i < list.length && inCode(list[i][0]); i++) {
      if (!list[i][1].startsWith(prefix)) {
        let j = i;
        while (j < list.length && j < i + 8 && list[j][0] === list[i][0] && !list[j][1].startsWith(prefix)) j++;
        if (j < list.length && j > i && list[j][1].startsWith(prefix) && list[j][0] >= list[i][0]) { i = j - 1; continue; }
        break;
      }
      const start = list[i][0];
      if (out.length && start === out[out.length - 1].start) continue; // another name for the same member
      out.push({ name: list[i][1], start, end: Math.min(nextSym(start), codeEnd) });
    }
    return out;
  };
  return { kind: 'symbols', has, addr, end: (n) => Math.min(nextSym(addr(n)), codeEnd), members, list };
}

// ---------------------------------------------------------------- the recipe
// functions and data the patch needs; every build with a hardware modem has them
export const FUNCS = ['InitModem', 'putchar_modem', 'putbuf_modem', 'getbuf_modem', 'ModemFIFOCount', 'ModemGetCD',
  'ReadModemReg', 'WriteModemReg', 'ModemIntHandler', 'ModemReset', 'EnableModemInterrupts',
  'DisableModemInterrupts', 'RegisterIntHandler', 'EnableInterrupt', 'DisableInterrupt', 'pppInterruptHandler',
  'InitParallelPort'];
export const DATA = ['modemRcvData', 'modemXmtData', 'modemRcvHead', 'modemRcvTail', 'modemXmtHead', 'modemXmtTail',
  'modemRcvBufDelta', 'modemXmtBufDelta'];
// replaced function -> driver function
const HOOKS = { EnableModemInterrupts: 'lm_unlock', DisableModemInterrupts: 'lm_lock', InitModem: 'lm_init', putchar_modem: 'lm_putchar', putbuf_modem: 'lm_putbuf',
  getbuf_modem: 'lm_getbuf', ModemFIFOCount: 'lm_fifocount', ModemGetCD: 'lm_getcd',
  ReadModemReg: 'lm_readreg', WriteModemReg: 'lm_writereg' };
// not in every build; their bodies become free space too
const OPTIONAL_HOOKS = { ModemSetDTR: 'lm_setdtr', ModemGetDTR: 'lm_getdtr' };
// replaced in place by two instructions (jr ra; <delay slot>), if present
const OPTIONAL_STUBS = {
  ModemGetCTS: 0x24020001, // li v0, 1: flow control is the link handshake
  ModemSetRTS: 0x00000000, // nop: RTS means nothing on the link
  // Print does nothing: the bridge has the printer port, so there is no printer. Unstubbed, the
  // Print panel's Print button (client:ShowPrintWindow) loads PrintSystem.mod and, on a disk
  // without it, calls into it anyway (16406: "Addr Err"). ExecuteClientFunction ignores what a
  // client function returns. (Not OpenPrintPanel too: it is a few words that look like many other
  // methods, and the signatures mistook it in 6 builds.)
  ShowPrintWindow: 0x00000000,
};
// functions whose bodies become free space once hooked (ModemIntHandler is never registered)
const CAVES = ['ModemIntHandler', 'InitModem', 'getbuf_modem', 'putbuf_modem', 'putchar_modem', 'ModemFIFOCount',
  'InitParallelPort', 'EnableModemInterrupts', 'DisableModemInterrupts'];
// The console channel: debug builds' 1997 parallel console -> driver function
const ECP_CONSOLE = { InitECPCharIO: 'pm_portinit', ECPCharIOOut: 'lm_ecpout', ECPCharIOIn: 'pm_conin' };
// the names the patch may use, beyond FUNCS and DATA (sigs.js recovers these too)
export const OPTIONAL = [...Object.keys(OPTIONAL_HOOKS), ...Object.keys(OPTIONAL_STUBS), 'SetCharIO', 'InitECPCharIO',
  'InitSucSerial', ...Object.keys(ECP_CONSOLE), 'Xfer2Bytes', 'putchar', 'gCharIOSelect', 'SafeReset',
  ...['IRIdle', 'irDataBuf', 'irHead', 'irTail', 'gSystemTicks', 'gLastIRTime', 'Now', 'ValidateSonyData']];
// The modem rings and PPP wake-up, by OS name
const PM_SYMS = { rcvData: 'modemRcvData', rcvHead: 'modemRcvHead', rcvTail: 'modemRcvTail', xmtData: 'modemXmtData',
  xmtHead: 'modemXmtHead', xmtTail: 'modemXmtTail', ppp: 'pppInterruptHandler' };

const DEV_INT_PARPORT = 0x10, DEVINTSTAT_C = 0xa4000174, RIO_INT_DEVICE0 = 0x04, RIOINTSTAT_C = 0xa400018c;
const isJrRa = (w) => w === 0x03e00008;
const isPrologue = (w) => (w & 0xffff8000) === 0x27bd8000; // addiu sp, sp, -n
// Can a function start after these two words? Yes after jr / j / b / break (the second word
// is its delay slot), or after a nop that isn't one (padding).
const isTerminal = (w) => (w >>> 26) === 2 || (w & 0xfc1fffff) === 0x00000008 || (w >>> 16) === 0x1000 || (w & 0xfc00003f) === 0x0000000d || w === 0x42000018;
const hasDelaySlot = (w) => { const o = w >>> 26; return o === 1 || o === 2 || o === 3 || (o >= 4 && o <= 7) || (o >= 0x14 && o <= 0x17) || (o === 0 && ((w & 0x3f) === 8 || (w & 0x3f) === 9)); };
export const startsAfter = (w2, w1) => isTerminal(w2) || (w1 === 0 && !hasDelaySlot(w2));
const isControl = (w) => { const o = w >>> 26; return o === 2 || o === 3 || (o >= 4 && o <= 7) || (o >= 0x14 && o <= 0x17) || o === 1 || (o === 0 && ((w & 0x3f) === 8 || (w & 0x3f) === 9)); };

// -> { version } for a patched build, else null
export function lptPatchInfo(img) {
  for (let o = 0; o + 8 <= img.length; o += 4) {
    if (be32(img, o) === SIGNATURE && be32(img, o + 4) < 0x100) return { version: be32(img, o + 4) };
  }
  return null;
}
export function isLptModemPatched(img) { const p = lptPatchInfo(img); return p ? p.version : 0; }

// symbols: symbols.sym bytes, or a symbol source (symbolSource, sigs.js recoverSymbols).
// opts: { console: false (no console channel), noDriverCaves, debug }
export function patchLptModem(imgIn, symbols, opts = {}) {
  const img = new Uint8Array(imgIn); // copy
  const info = osImageInfo(img);
  const base = info.base, codeEnd = base + info.codeSize;
  const report = [];
  if (lptPatchInfo(img)) throw new PatchError('this build is already patched for the LPT modem');
  const S = typeof symbols?.addr === 'function' ? symbols : symbolSource(new Uint8Array(symbols), img);
  if (S.kind !== 'symbols') report.push(`symbols: ${S.kind}`);
  const addrs = new Map();
  for (const n of [...FUNCS, ...DATA]) addrs.set(n, S.addr(n));
  { const hi = (a) => ((a + 0x8000) >>> 16) & 0xffff, h = hi(addrs.get(DATA[0]));
    for (const n of DATA) if (hi(addrs.get(n)) !== h) throw new PatchError(`modem globals are not in one 64 KB window (${n})`); }
  const inCode = (a) => a >= base && a < codeEnd;
  for (const n of FUNCS) if (!inCode(addrs.get(n))) throw new PatchError(`${n} at ${hex(addrs.get(n))} is outside the build's code (symbols don't match this image?)`);
  const word = (a) => be32(img, a - base);
  const setWord = (a, v) => put32(img, a - base, v >>> 0);
  const has = (n) => S.has(n) && inCode(S.addr(n));
  // jal / j sites aimed at `to`
  const callSites = (to) => {
    const want = (to >>> 2) & 0x3ffffff, out = [];
    for (let p = base; p < codeEnd; p += 4) { const w = word(p); if (((w >>> 26) === 3 || (w >>> 26) === 2) && (w & 0x3ffffff) === want) out.push(p); }
    return out;
  };

  // ---- interrupt numbers, from the OS's own code and interrupt table
  const modemInt = (() => {
    const a = addrs.get('InitModem'), reg = addrs.get('RegisterIntHandler');
    const end = Math.min(S.end('InitModem'), a + 0x400);
    for (let p = a; p < end; p += 4) {
      const w = word(p);
      if ((w >>> 26) === 3 && ((w & 0x3ffffff) << 2) === (reg & 0x0ffffffc)) {
        for (let q = p - 4; q >= Math.max(a, p - 32); q -= 4) { const v = word(q); if ((v & 0xffff0000) === 0x24040000) return v & 0xffff; }
        if ((word(p + 4) & 0xffff0000) === 0x24040000) return word(p + 4) & 0xffff;
      }
    }
    throw new PatchError('could not find the modem interrupt number in InitModem');
  })();
  // EnableInterrupt indexes a 16-byte-per-interrupt table [mask, status-clear register,
  // enable register, disable register]: lui rX, hi ... then addiu rX, rX, lo (1999+) or
  // lw rY, lo(rX + index) (1998)
  const intTable = (() => {
    const a = addrs.get('EnableInterrupt');
    for (let p = a; p < a + 32; p += 4) {
      const w = word(p);
      if ((w >>> 26) !== 0x0f) continue;
      const r = (w >>> 16) & 31, hi = (w & 0xffff) << 16;
      let lwMin = null;
      for (let q = p + 4; q < p + 28; q += 4) {
        const w2 = word(q), op = w2 >>> 26, rs = (w2 >>> 21) & 31, rt = (w2 >>> 16) & 31, imm = (w2 << 16) >> 16;
        if (op === 0x09 && rs === r && rt === r) return (hi + imm) >>> 0;
        if (op === 0x23 && rs === r && (lwMin === null || imm < lwMin)) lwMin = imm;
      }
      if (lwMin !== null) return (hi + lwMin) >>> 0;
    }
    return null;
  })();
  const inImage = (x) => x >= base && x + 16 <= base + img.length;
  const entry = (n) => { const o = intTable + n * 16; return inImage(o) ? [0, 1, 2, 3].map((i) => word(o + i * 4)) : [0, 0, 0, 0]; };
  let lptInt = -1;
  const e = intTable !== null ? entry(modemInt) : [0, 0];
  if (e[0] === RIO_INT_DEVICE0 && e[1] === RIOINTSTAT_C) {
    for (let n = 0; n < 64; n++) { const x = entry(n); if (x[0] === DEV_INT_PARPORT && x[1] === DEVINTSTAT_C) { lptInt = n; break; } }
    if (lptInt < 0) throw new PatchError('no parallel port entry in the interrupt table');
  } else if (modemInt === 0x16) {
    // the table isn't readable in the image (data stored elsewhere); SOLO builds number the
    // sources the same way: RIO device 0 = 0x16, parallel port = 0x1d
    lptInt = 0x1d;
    report.push('interrupt table not readable in the image; using the standard SOLO numbering');
  } else throw new PatchError(`interrupt ${modemInt} does not look like the modem`);
  report.push(`modem interrupt ${hex(modemInt).slice(6)}, parallel port interrupt ${hex(lptInt).slice(6)}`);

  // ---- sanity: the rings are 4 KB (andi ..., 0xfff in putchar_modem)
  {
    const a = addrs.get('putchar_modem');
    let ok = false;
    for (let p = a; p < S.end('putchar_modem'); p += 4) { const w = word(p); if ((w >>> 26) === 0x0c && (w & 0xffff) === 0x0fff) ok = true; }
    if (!ok) throw new PatchError('putchar_modem does not use 4 KB rings; refusing');
  }

  // ---- the console channel: which hooks this build takes
  let con = null;
  if (opts.console !== false) {
    if (Object.keys(ECP_CONSOLE).every(has)) {
      con = { ecp: true };
      // and keep it there: the Print panel turns the parallel console off (SetCharIO without
      // 0x10, "ECP IO off!") to free the port, which left a crash after it with no console
      if (has('SetCharIO')) {
        const sc = S.addr('SetCharIO'), d = [word(sc), word(sc + 4)];
        if (d.some(isControl)) report.push('SetCharIO starts with a branch; the parallel console can be turned off');
        else con.setCharIo = d;
      }
    }
    else if (has('putchar') && has('SetCharIO') && S.has('gCharIOSelect')) {
      const pc = S.addr('putchar'), sc = S.addr('SetCharIO');
      const d = [word(pc), word(pc + 4), word(sc), word(sc + 4)];
      if (d.some(isControl)) report.push('putchar or SetCharIO starts with a branch; no console channel');
      else con = { putchar: d.slice(0, 2), setCharIo: d.slice(2) };
    } else report.push('no console output path found; no console channel');
  }

  // ---- free space: bodies of the replaced functions (after the 8-byte hook)
  const caves = [];
  const optionalHooks = Object.keys(OPTIONAL_HOOKS).filter(has);
  const optionalStubs = Object.keys(OPTIONAL_STUBS).filter(has);
  const caveNames = [...CAVES, ...optionalHooks, ...optionalStubs];
  if (con?.ecp) {
    caveNames.push(...Object.keys(ECP_CONSOLE));
    // the 1997 exchange itself, once nothing else calls it
    if (has('Xfer2Bytes')) {
      const own = Object.keys(ECP_CONSOLE).map((n) => [S.addr(n), S.end(n)]);
      if (callSites(S.addr('Xfer2Bytes')).every((p) => own.some(([a, z]) => p >= a && p < z))) caveNames.push({ name: 'Xfer2Bytes', whole: true });
    }
  }
  for (const c of caveNames) {
    const n = c.name || c, a = S.addr(n);
    let end = S.end(n);
    // stop at anything that looks like another (unnamed) function after a return
    for (let p = a + 8; p + 8 < end; p += 4) {
      if (isJrRa(word(p)) && isPrologue(word(p + 8))) {
        // jump tables (ModemIntHandler) hold addresses inside the function, not code
        end = p + 8;
        break;
      }
    }
    caves.push({ name: n, start: c.whole ? a : a + 8, end, used: 0 });
  }
  // The printer driver (class ParallelDriver) is dead once InitParallelPort no longer creates
  // it: its methods are reached only through gParallelDriver, which stays NULL. Each method
  // keeps a two-instruction stub (return -1, for the debug monitor's unguarded "test
  // printer") and the rest of its body becomes free space.
  const driverStubs = [];
  const methods = opts.noDriverCaves ? [] : S.members('ParallelDriver');
  if (methods.length) {
    const ipp = addrs.get('InitParallelPort');
    // InitParallelPort's extent by code (symbols are sometimes misplaced inside functions)
    let ippEnd = ipp + 4;
    while (ippEnd < Math.min(ipp + 0x400, codeEnd) && !(isJrRa(word(ippEnd)) && isPrologue(word(ippEnd + 8)))) ippEnd += 4;
    const foreign = callSites(methods[0].start).some((p) => (word(p) >>> 26) === 3 && (p < ipp || p > ippEnd));
    if (!foreign) {
      for (const { name, start, end } of methods) {
        if (end - start < 8) continue;
        driverStubs.push(start);
        if (end - start > 8) caves.push({ name, start: start + 8, end, used: 0, optional: true });
      }
    }
  }
  caves.sort((x, y) => (y.end - y.start) - (x.end - x.start));
  if (opts.debug) for (const c of caves) console.log(`cave ${c.name} ${hex(c.start)}..${hex(c.end)} (${c.end - c.start})`);

  // every word changed outside the placed code, for listings: { fn, at, words, what }
  const sites = [];
  // ---- assemble and place
  const units = [];
  const equ = new Map();
  const sources = [];   // for listings (tools/asmlist.mjs)
  const add = (source, file) => {
    sources.push({ file, text: source });
    const prog = parse(source, file);
    units.push(...prog.units);
    for (const [k, v] of prog.equ) {
      const same = (x, y) => x.replace(/\s/g, '') === y.replace(/\s/g, '') || (Number(x) === Number(y) && !Number.isNaN(Number(x)));
      if (equ.has(k) && !same(equ.get(k), v)) throw new PatchError(`internal: .equ ${k} defined twice (${equ.get(k)} / ${v})`);
      equ.set(k, v);
    }
  };
  // keys from the bridge go into the OS's IR input ring, when it is the one this knows (16406's):
  // 64 entries of 8 bytes, irHead right after them and irTail after it, and IRIdle taking an
  // entry's halfword at 2 as remote-or-keyboard. Older builds lay their entries out otherwise.
  let ir = null;
  if (has('IRIdle') && ['irDataBuf', 'irHead', 'irTail', 'gSystemTicks', 'gLastIRTime'].every((n) => S.has(n))
      && S.addr('irHead') - S.addr('irDataBuf') === 0x200 && S.addr('irTail') - S.addr('irHead') === 4) {
    const a = S.addr('IRIdle');
    for (let p = a; p < a + 0x80; p += 4) {
      const w = word(p);
      if ((w >>> 26) === 0x25 && (w & 0xffff) === 2) { ir = { buf: 'irDataBuf', head: 'irHead', tail: 'irTail', ticks: 'gSystemTicks', last: 'gLastIRTime' }; break; }   // lhu rt, 2(rs)
    }
  }
  report.push(ir ? 'keys from the bridge: into irDataBuf' : 'no IR input ring this knows; no keys from the bridge');
  add(parmodSource({ ...PM_SYMS, ir }), 'parmod');
  // SafeReset tells the bridge first (the reboot notice, §10.7)
  let reboot = null;
  if (has('SafeReset')) {
    const a = S.addr('SafeReset'), d = [word(a), word(a + 4)];
    if (d.some(isControl)) report.push('SafeReset starts with a branch; no reboot notice');
    else { reboot = a; add(rebootSource(d), 'reboot'); }
  } else report.push('no SafeReset in this build; no reboot notice');
  add(driverSource({ lptInt }), 'driver');
  if (con) add(consoleSource(con), 'console');
  const labels = new Map();

  // ---- the driver's state (PM_VARS) out of the OS's write fence. ProtectMemory points the J2
  // fence (4 KB granularity; SOLO BUS_J2FENCE at 0xa40000b8 / 0xbc) at the whole OS image in RAM,
  // and a write inside it is cancelled and raises the fence interrupt (a debug build stops in its
  // debugger). PM_VARS goes into the free filler after the code instead, and the fence's top is
  // pinned below it: the code stays protected, the ROM filesystem after the filler doesn't.
  const vars = (() => {
    // the J2 top store: lui rX, 0xa400; ori rX, rX, 0xbc ... sw rS, 0(rX), rS = addu rS, rS, rT
    let site = null;
    for (let p = base; p < codeEnd && !site; p += 4) {
      const w = word(p);
      if ((w >>> 26) !== 0x0f || (w & 0xffff) !== 0xa400) continue;
      const rx = (w >>> 16) & 31;
      for (let q = p + 4; q < p + 64 && q < codeEnd; q += 4) {
        const o = word(q);
        if (o !== ((0x0d << 26) | (rx << 21) | (rx << 16) | 0xbc)) continue;
        for (let t = q + 4; t < q + 64 && t < codeEnd; t += 4) {
          const st = word(t);
          if ((st >>> 26) !== 0x2b || ((st >>> 21) & 31) !== rx || (st & 0xffff) !== 0) continue;
          const rs = (st >>> 16) & 31;
          for (let u = t - 4; u > q - 32 && u >= p - 64; u -= 4) {   // the add that makes the top
            const a = word(u);
            if ((a >>> 26) === 0 && (a & 0x3f) === 0x21 && ((a >>> 11) & 31) === rs && ((a >>> 21) & 31) === rs) { site = { at: u, rs }; break; }
            if ((a >>> 26) === 0 && ((a >>> 11) & 31) === rs) break;   // rs made some other way
          }
          break;
        }
        break;
      }
    }
    if (!site) return null;
    // the filler after the code ("beoj" words; 1998-99 builds "joeb")
    const fill = new Set([0x62656f6a, 0x6a6f6562]);
    let fe = codeEnd;
    while (fe + 4 <= base + info.size && fill.has(word(fe))) fe += 4;
    const size = PMV.SIZE, up = ((codeEnd + 0xffff) & ~0xffff) >>> 0;
    const at = up + size <= fe ? up : ((codeEnd + 31) & ~31) >>> 0;
    if (at + size > fe) return null;
    return { site, at, top: (at & ~0xffff) >>> 0, fillEnd: fe };
  })();
  if (vars) {
    const i = units.findIndex((u) => u.name === 'PM_VARS');
    if (i >= 0) units.splice(i, 1);
    labels.set('PM_VARS', vars.at);
    for (let p = vars.at; p < vars.at + PMV.SIZE; p += 4) setWord(p, 0);
    setWord(vars.site.at, (0x0f << 26) | (vars.site.rs << 16) | (vars.top >>> 16));   // lui rs, top
    sites.push({ fn: 'ProtectMemory', at: vars.site.at, words: [word(vars.site.at)],
      what: `lui: the J2 write fence ends at ${hex(vars.top)}, below the driver's state` });
    sites.push({ fn: 'filler', at: vars.at, words: [0], what: `PM_VARS, ${PMV.SIZE} bytes (zeroed)` });
    report.push(`driver state at ${hex(vars.at)} (filler after the code); J2 write fence top ${hex(vars.top)} (was the image's end)`);
  } else report.push('no J2 fence set-up found, or no room after the code: the driver state stays in the code');

  const lookup = (name) => {
    if (labels.has(name)) return labels.get(name);
    if (equ.has(name)) { const v = evaluate(equ.get(name), lookup, `equ ${name}`); return v === null ? undefined : v; }
    if (addrs.has(name)) return addrs.get(name);
    if (S.has(name)) return S.addr(name);
    return undefined;
  };
  for (const u of units) prepare(u, lookup);
  const placed = [];
  for (const u of [...units].sort((x, y) => unitSize(y) - unitSize(x))) {
    const size = unitSize(u);
    let cave = null; // best fit: the tightest cave that holds it
    for (const c of caves) { const free = c.end - c.start - c.used; if (free >= size && (!cave || free < cave.end - cave.start - cave.used)) cave = c; }
    if (!cave) throw new PatchError(`no room for ${u.name} (${size} bytes; ${caves.reduce((s, c) => s + c.end - c.start - c.used, 0)} bytes left in ${caves.length} pieces)`);
    const at = cave.start + cave.used;
    cave.used += size;
    placed.push({ u, at, cave: cave.name });
    for (const [k, v] of unitLabels(u, at)) labels.set(k, v);
  }
  for (const p of placed) {
    p.bytes = assemble(p.u, p.at, lookup);
    img.set(p.bytes, p.at - base);
  }
  // clear the rest of each cave (old code must not be mistaken for live code)
  for (const c of caves) if (!c.optional || c.used) for (let p = c.start + c.used; p < c.end; p += 4) setWord(p, 0);
  const used = caves.reduce((s, c) => s + c.used, 0), room = caves.reduce((s, c) => s + c.end - c.start, 0);
  report.push(`driver: ${used} bytes placed in ${caves.filter((c) => c.used).map((c) => c.name).join(', ')} (${room} bytes free)`);

  // ---- hooks: j <replacement>; nop
  const jump = (from, to, fn, label) => {
    if (((from + 4) & 0xf0000000) !== (to & 0xf0000000)) throw new PatchError('jump out of segment');
    setWord(from, (2 << 26) | ((to >>> 2) & 0x3ffffff));
    setWord(from + 4, 0);
    sites.push({ fn, at: from, words: [word(from), 0], what: `j ${label}; nop` });
  };
  const hooked = [];
  for (const [fn, rep] of Object.entries(HOOKS)) { jump(addrs.get(fn), labels.get(rep), fn, rep); hooked.push(fn); }
  for (const fn of optionalHooks) { jump(S.addr(fn), labels.get(OPTIONAL_HOOKS[fn]), fn, OPTIONAL_HOOKS[fn]); hooked.push(fn); }
  for (const fn of optionalStubs) {
    setWord(S.addr(fn), 0x03e00008); setWord(S.addr(fn) + 4, OPTIONAL_STUBS[fn]); hooked.push(fn);
    sites.push({ fn, at: S.addr(fn), words: [0x03e00008, OPTIONAL_STUBS[fn]], what: 'stub: jr ra, with the result in the delay slot' });
  }
  report.push(`hooked ${hooked.join(', ')}`);
  if (reboot) { jump(reboot, labels.get('lm_reboot'), 'SafeReset', 'lm_reboot'); report.push('SafeReset: sends REBOOT first'); }
  if (con?.ecp) {
    for (const [fn, rep] of Object.entries(ECP_CONSOLE)) jump(S.addr(fn), labels.get(rep), fn, rep);
    report.push('console channel: the parallel debug console (SetCharIO flag 0x10) is the bridge\'s');
    if (con.setCharIo) {
      jump(S.addr('SetCharIO'), labels.get('lm_setchario_con'), 'SetCharIO', 'lm_setchario_con');
      report.push('SetCharIO: flag 0x10 always on (the Print panel can\'t turn the console off)');
    }
  } else if (con) {
    jump(S.addr('putchar'), labels.get('lm_putchar_con'), 'putchar', 'lm_putchar_con');
    jump(S.addr('SetCharIO'), labels.get('lm_setchario_con'), 'SetCharIO', 'lm_setchario_con');
    report.push('console channel: putchar output also goes to the bridge (SetCharIO flag 0x10, always on)');
  }

  // ---- the remaining modem-interrupt users move to the parallel port interrupt
  for (const n of ['ModemReset']) {
    const a = addrs.get(n);
    let count = 0;
    for (let p = a; p < S.end(n); p += 4) if (word(p) === (0x24040000 | modemInt)) {
      setWord(p, 0x24040000 | lptInt); count++;
      sites.push({ fn: n, at: p, words: [word(p)], what: `li a0, 0x${lptInt.toString(16)}: the parallel port's interrupt, not the modem's` });
    }
    if (!count) throw new PatchError(`${n} does not load the modem interrupt number`);
  }
  report.push('Enable/DisableModemInterrupts and ModemReset use the parallel port interrupt');

  // ---- printer driver off
  for (const a of driverStubs) {
    setWord(a, 0x03e00008); setWord(a + 4, 0x2402ffff); // jr ra; li v0, -1
    sites.push({ fn: 'ParallelDriver method', at: a, words: [0x03e00008, 0x2402ffff], what: 'jr ra; li v0, -1 (the printer driver off)' });
  }
  if (driverStubs.length) report.push(`ParallelDriver: ${driverStubs.length} methods stubbed`);
  const ipp = addrs.get('InitParallelPort');
  setWord(ipp, 0x03e00008); // jr ra
  setWord(ipp + 4, 0x00001021); // move v0, zero
  sites.push({ fn: 'InitParallelPort', at: ipp, words: [0x03e00008, 0x00001021], what: 'jr ra; move v0, zero (no printer)' });
  report.push('InitParallelPort disabled (no printer driver)');

  // ---- no fast reboot from RAM. Reboot(0xdd), the power-off path, writes 'fast', then
  // ValidateMaxiBrowser and, if the image in RAM checks out, BootRAMImage jumps into it with no
  // reset. Since PM_VARS left the checksummed code (DRIVER_VERSION 4) the image checks out, and
  // the restarted OS met the old PARMOD session (its modem stalled). Without the jump it falls
  // through to the warm reboot: SafeReset, REBOOT, the bridge reads and patches it again.
  {
    const w = (o) => be32(img, o);
    let site = null;
    for (let o = 0; o + 8 <= info.codeSize && !site; o += 4) {
      if ((w(o) & 0xffe0ffff) !== 0x3c006661 || (w(o + 4) & 0xfc00ffff) !== 0x34007374) continue;   // lui rX, 'fa'; ori rX, rX, 'st'
      for (let q = o + 8; q + 16 <= Math.min(info.codeSize, o + 160); q += 4) {
        if ((w(q) >>> 26) === 3 && w(q + 4) === 0 && (w(q + 8) >>> 26) === 3 && (w(q + 12) === 0x00402021 || w(q + 12) === 0x0040202d)) { site = base + q + 8; break; }
      }
    }
    if (!site) throw new PatchError("no fast reboot (Reboot's jal BootRAMImage) found");
    if (S.has('BootRAMImage') && (((word(site) & 0x3ffffff) << 2 | (site & 0xf0000000)) >>> 0) !== S.addr('BootRAMImage')) throw new PatchError('the fast reboot found does not call BootRAMImage');
    sites.push({ fn: 'Reboot', at: site, words: [0], what: 'nop (was jal BootRAMImage): no restart from RAM; the warm reboot instead' });
    setWord(site, 0);
    report.push(`Reboot: no fast reboot from RAM at ${hex(site)}`);
  }

  // ---- checksum
  let sum = 0;
  for (let o = 0; o < info.codeSize; o += 4) if (o !== 8) sum = (sum + be32(img, o)) >>> 0;
  put32(img, 8, sum);
  const after = osImageInfo(img);
  if (!after.checksumOk) throw new PatchError('checksum update failed');
  report.push(`checksum ${hex(info.checksum)} -> ${hex(sum)}`);
  sites.push({ fn: 'header', at: base + 8, words: [sum], what: 'the code checksum' });
  return { image: img, report, lptInt, modemInt, version: DRIVER_VERSION, labels, sources, placed, sites };
}

// ---- the bridge's settings that change the OS: words it writes after the patch (and fixes the
// code checksum for), found by their code so builds without symbols get them too.
//   ir:    InitSoloIR's last `ori v0, v0, 4` before `sb v0, IRDecodeFlags`: the decoders the box
//          turns on whatever its maker (4 = the WebTV remote's). The bridge ORs in 1 (Sony's
//          20-bit WebTV remote) and 2 (Philips RC-5) as asked. The OS ORs in its maker's own
//          bits too, so a box's own remote always works.
//   power: UserTaskMain's `beq v0, zero` after `andi v0, v0, 8` on NVGetFlags: kPowerOnReboot
//          (the OS powers on by itself after its own upgrade reboot). A nop there: the OS
//          powers on at every start instead of waiting in standby for the power key.
// -> { ir: [byte offset, word] | null, power: [byte offset, word] | null } (words as they are)
export function optionSites(img) {
  const info = osImageInfo(img), n = info.codeSize, w = (o) => be32(img, o);
  let ir = null, power = null;
  // RecognizeAllSupportedRemotes: li v0, 0x1f (0x7 in 1998) and lui rX, 0x8000 (either order);
  // jr ra; sb v0, flags(rX)
  for (let o = 0; o + 16 <= n && !ir; o += 4) {
    if (w(o + 8) !== 0x03e00008) continue;
    const a = w(o), b = w(o + 4), sb = w(o + 12);
    const li = (x) => x === 0x2402001f || x === 0x24020007, lui = (x) => (x & 0xffe0ffff) === 0x3c008000;
    const l = li(a) && lui(b) ? b : lui(a) && li(b) ? a : 0;
    if (!l) continue;
    const rx = (l >>> 16) & 31;
    if ((sb >>> 26) !== 0x28 || ((sb >>> 21) & 31) !== rx || ((sb >>> 16) & 31) !== 2) continue;
    const off = sb & 0xffff;
    for (let p = o - 4; p >= Math.max(0, o - 0x400) && !ir; p -= 4) {
      if (w(p) !== 0x34420004) continue;
      for (let q = p + 4; q <= p + 12; q += 4) {
        const s = w(q);
        if ((s >>> 26) === 0x28 && ((s >>> 16) & 31) === 2 && (s & 0xffff) === off) { ir = [p, w(p)]; break; }
      }
    }
  }
  for (let o = 0; o + 40 <= n; o += 4) {
    if (w(o) !== 0x30420008 || (w(o + 4) >>> 16) !== 0x1040) continue;
    for (let q = o + 8; q < o + 40; q += 4) if (w(q) === 0x2404fff7) { power = [o + 4, w(o + 4)]; break; }
    if (power) break;
  }
  return { ir, power };
}
