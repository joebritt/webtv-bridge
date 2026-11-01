// Assembler listings of the bridge's MIPS: the OS patch (src/lptmodem/) and the loader, stage 0
// and the tier-3 stub (src/stockbox/). Each source line with its comments, and where it emits
// code, the address and the machine words, as placed for one build.
//
//   node tools/asmlist.mjs patch <_approm.o> [symbols.sym] [-o out.txt]
//   node tools/asmlist.mjs loader | stage0 | tier3 [-o out.txt]
//
// listing(sources, placed) is the engine: sources = [{ file, text }] as handed to parse(),
// placed = [{ u, at, bytes, cave? }] (patch.js and loader.js return both).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const hex8 = (v) => (v >>> 0).toString(16).padStart(8, '0');
const insnCount = (l) => (l.op === 'la' ? 2 : l.op === 'li' ? l.liWords || 2 : l.op ? 1 : 0);

export function listing(sources, placed) {
  // source line -> [{ pc, words }], and the line each unit starts on -> its placement
  const at = new Map(), starts = new Map();
  for (const p of placed) {
    let pc = p.at >>> 0, off = 0;
    starts.set(p.u.lines[0].ctx, p);
    for (const l of p.u.lines) {
      const n = insnCount(l);
      if (!n) continue;
      const words = [];
      for (let k = 0; k < n; k++, off += 4) words.push((p.bytes[off] << 24) | (p.bytes[off + 1] << 16) | (p.bytes[off + 2] << 8) | p.bytes[off + 3]);
      (at.get(l.ctx) || at.set(l.ctx, []).get(l.ctx)).push({ pc, words });
      pc = (pc + n * 4) >>> 0;
    }
  }
  const pad = ' '.repeat(19);
  const out = [];
  for (const { file, text } of sources) {
    const lines = text.split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    const skip = text.split('\n').findIndex((l) => l.trim());   // lines dropped above, for ctx numbers
    lines.forEach((src, i) => {
      const ctx = `${file}:${i + skip + 1}`;
      const p = starts.get(ctx);
      if (p) out.push(`${pad}# ---- ${p.u.name}: ${p.bytes.length} bytes at 0x${hex8(p.at)}${p.cave ? ` (in ${p.cave})` : ''}`);
      const emitted = at.get(ctx);
      if (!emitted) { out.push(src ? pad + src : ''); return; }
      const words = emitted.flatMap((e) => e.words.map((w, k) => ({ pc: e.pc + 4 * k, w })));
      words.forEach(({ pc, w }, k) => out.push(`${hex8(pc)}  ${hex8(w)} ${k ? '' : src}`.trimEnd()));
    });
    out.push('');
  }
  return collapse(out).join('\n');
}

// runs of the same word from the same source line (a zeroed data block) -> the first, and a count
function collapse(lines) {
  const res = [];
  for (let i = 0; i < lines.length;) {
    const m = lines[i].match(/^[0-9a-f]{8}  ([0-9a-f]{8}) (.*)$/);
    let j = i + 1;
    if (m) while (j < lines.length && lines[j].slice(8) === lines[i].slice(8)) j++;
    res.push(lines[i]);
    if (j - i > 3) {
      res.push(`${' '.repeat(19)}... ${j - i - 1} more of the same, to ${lines[j - 1].slice(0, 8)}`);
      i = j;
    } else i++;
  }
  return res;
}

export function sitesListing(sites) {
  return sites.map((s) => `${hex8(s.at)}  ${s.words.map(hex8).join(' ').padEnd(17)}  ${s.fn}: ${s.what}`).join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('-o');
  const outFile = oi >= 0 ? args.splice(oi, 2)[1] : null;
  const [what, img, symArg] = args;
  let text;
  if (what === 'patch' && img) {
    const { patchLptBuild } = await import('../src/lptmodem/patchbuild.js');
    const sym = symArg || join(dirname(img), 'symbols.sym');
    const r = patchLptBuild(readFileSync(img), existsSync(sym) ? readFileSync(sym) : null);
    text = `# words changed in the build's own code\n${sitesListing(r.sites)}\n\n# the placed code\n${listing(r.sources, r.placed)}`;
  } else if (what === 'tier3') {
    const { buildTier3Parts } = await import('../src/stockbox/tier3.js');
    const b = buildTier3Parts();
    text = listing(b.sources, b.placed);
  } else if (what === 'loader' || what === 'stage0') {
    const { buildLoader, buildStage0 } = await import('../src/stockbox/loader.js');
    const b = what === 'loader' ? buildLoader() : buildStage0();
    text = listing(b.sources, b.placed);
  } else {
    console.error('usage: asmlist.mjs patch <_approm.o> [symbols.sym] | loader | stage0 | tier3 [-o out.txt]');
    process.exit(2);
  }
  if (outFile) writeFileSync(outFile, text); else process.stdout.write(text);
}
