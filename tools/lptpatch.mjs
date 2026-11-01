// Patch a WebTV OS build for the LPT modem bridge.
//   node tools/lptpatch.mjs <_approm.o> [symbols.sym] [-o out.o]
// symbols.sym defaults to the one next to the image (the ROM collection layout); without one,
// the names the patch needs are found from the code by signature (src/lptmodem/sigs.js).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { patchLptBuild } from '../src/lptmodem/patchbuild.js';

const args = process.argv.slice(2);
const oi = args.indexOf('-o');
const out = oi >= 0 ? args.splice(oi, 2)[1] : null;
const [img, symArg] = args;
if (!img) { console.error('usage: node tools/lptpatch.mjs <_approm.o> [symbols.sym] [-o out.o]'); process.exit(2); }
const sym = symArg || join(dirname(img), 'symbols.sym');
if (!existsSync(sym)) console.log(`no symbols file (${sym}); finding the names by signature`);
try {
  const { image, report } = patchLptBuild(readFileSync(img), existsSync(sym) ? readFileSync(sym) : null);
  for (const l of report) console.log(l);
  if (out) { writeFileSync(out, image); console.log(`wrote ${out}`); }
} catch (e) {
  console.error(`cannot patch: ${e.message}`);
  process.exit(1);
}
