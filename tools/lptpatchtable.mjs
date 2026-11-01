#!/usr/bin/env node
// The bridge's patch table (WEBTV_LPT_BRIDGE.md §10.7): every collection build's PARMOD patch
// as the runs of words it changes in the OS image, so the bridge can
// patch an OS in the box's RAM without a patcher of its own.
//
//   node tools/lptpatchtable.mjs [-o src/stockbox/patches.json.gz]
//
// An entry is keyed by what the bridge reads from the image in RAM: the code checksum (header
// word 2), the build size and the ROM filesystem's word sum (its trailer); builds that share
// all three are one entry. Builds the patch refuses are left out. `options` holds the words the
// bridge's settings change after the patch (patch.js optionSites).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { patchLptBuild } from '../src/lptmodem/patchbuild.js';
import { optionSites } from '../src/lptmodem/patch.js';
import { osImageInfo } from '../src/machine/osinstall.js';
import { imageIdentity, PATCH_TABLE_VERSION } from '../src/stockbox/patchtable.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const out = opt('-o', 'src/stockbox/patches.json.gz');
const hex = (v) => (v >>> 0).toString(16).padStart(8, '0');
const same = (a, b, o) => a[o] === b[o] && a[o + 1] === b[o + 1] && a[o + 2] === b[o + 2] && a[o + 3] === b[o + 3];

const builds = {};
let refused = 0, dup = 0;
for (const p of execSync('find data/rom-collection -name _approm.o').toString().trim().split('\n').sort()) {
  const d = p.replace(/\/_approm.o$/, ''), name = d.replace(/^.*US-LC2-disk-0MB-8MB\//, '');
  const img = new Uint8Array(readFileSync(p));
  let info;
  try { info = osImageInfo(img); } catch { continue; }
  const before = img.subarray(0, info.size);
  const id = imageIdentity(before);
  if (!id) continue;
  if (builds[id.key]) { builds[id.key].names.push(name); dup++; continue; }
  let r;
  try { r = patchLptBuild(img, existsSync(`${d}/symbols.sym`) ? readFileSync(`${d}/symbols.sym`) : null); } catch { refused++; continue; }
  const after = r.image.subarray(0, info.size);
  const runs = [];
  for (let o = 0; o < info.size; o += 4) {
    if (same(before, after, o)) continue;
    let e = o + 4;
    while (e < info.size && !(same(before, after, e) && (e + 4 >= info.size || same(before, after, e + 4)))) e += 4;
    runs.push([o, Buffer.from(after.subarray(o, e)).toString('hex')]);
    o = e - 4;
  }
  const idAfter = imageIdentity(after);
  // the words the bridge's settings change (remotes, power-on): [byte offset, word after the patch]
  const o = optionSites(r.image);
  for (const [k, v] of Object.entries(o)) if (v && runs.some(([ro, h]) => v[0] >= ro && v[0] < ro + h.length / 2)) throw new Error(`${name}: option ${k} inside the patch`);
  const keys = r.report.includes('keys from the bridge: into irDataBuf');   // its IR input ring takes keys over PARMOD
  builds[id.key] = { names: [name], base: info.base, size: info.size, version: info.version, after: idAfter, runs, options: o, ...(keys ? { keys: 1 } : {}) };
}
const table = { version: PATCH_TABLE_VERSION, link: 2, builds };
const gz = gzipSync(JSON.stringify(table));
writeFileSync(out, gz);
const n = Object.keys(builds).length;
const raw = Object.values(builds).reduce((s, b) => s + b.runs.reduce((t, [, h]) => t + 6 + h.length / 2, 0), 0);
console.log(`${n} builds (${dup} duplicates folded in, ${refused} refused): ${(raw / 1024).toFixed(0)} KB of runs, ${(gz.length / 1024).toFixed(0)} KB compressed -> ${out}`);
