// Patch the OS on a WebTV disk image for the LPT modem bridge, for writing to a real disk with dd.
//
//   node tools/lptdisk.mjs DISK.bin                                  what is in the two OS slots
//   node tools/lptdisk.mjs DISK.bin --patch -o OUT.bin               patch the builds already there
//   node tools/lptdisk.mjs DISK.bin --build _approm.o -o OUT.bin     install a build, patched, in both slots
//   node tools/lptdisk.mjs DISK.bin --tier3 -o OUT.bin               the bridge's loader in the tier-3 area
//                                                                    (the area as it was is saved to OUT.bin.tier3-backup.bin)
//                                                                    (WEBTV_LPT_BRIDGE.md §10.7: for boxes whose
//                                                                    boot ROM has no debug monitor; the OS is untouched)
//
// Options:
//   --syms FILE        symbols.sym for the build (default: next to --build, or found by matching
//                      the installed build against the ROM collection; with none, the names the
//                      patch needs are found in the code by signature, src/lptmodem/sigs.js)
//   --collection DIR   where to look for installed builds (default data/rom-collection)
//   --no-patch         with --build: install it unpatched (e.g. to undo a patch)
//   --in-place         write DISK.bin itself instead of -o
//   --force            overwrite an existing -o file
//
// The boot ROM keeps two OS slots ("Browser 0" at LBA 1027, "Browser 1" at 17411) and a select
// block that says which one boots, so both are written. With --patch, each slot is patched with
// the symbols of the build it holds; a slot whose build can't be identified is left alone (the
// box then just uses its modem if it boots that slot). Disk images usually have every 16-bit
// word byte-swapped (ATA order); the tool works out which order this image uses from the slot
// headers and writes back in the same order. Every write is read back and checked.
import { readFileSync, writeFileSync, openSync, readSync, writeSync, closeSync, fstatSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { osImageInfo, OS_SLOTS, OS_SLOT_SECTORS } from '../src/machine/osinstall.js';
import { isLptModemPatched, lptPatchInfo } from '../src/lptmodem/patch.js';
import { patchLptBuild } from '../src/lptmodem/patchbuild.js';
import { buildTier3, TIER3_LBA, TIER3_SECTORS } from '../src/stockbox/tier3.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);
const oi = args.indexOf('-o');
const outArg = oi >= 0 ? args[oi + 1] : null;
const takesValue = ['-o', '--build', '--syms', '--collection'];
const disk = args.find((a, i) => !a.startsWith('-') && !takesValue.includes(args[i - 1]));
const fail = (msg) => { console.error(msg); process.exit(1); };
if (!disk) fail('usage: node tools/lptdisk.mjs DISK.bin [--patch | --build _approm.o] [-o OUT.bin | --in-place]');

const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const swap16 = (b) => { const o = new Uint8Array(b.length); for (let i = 0; i + 1 < b.length; i += 2) { o[i] = b[i + 1]; o[i + 1] = b[i]; } return o; };

function readAt(fd, pos, len) {
  const b = new Uint8Array(len);
  const n = readSync(fd, b, 0, len, pos);
  return n === len ? b : b.subarray(0, n);
}

// -> { swapped, img, info } or { error }
function readSlot(fd, lba) {
  const head = readAt(fd, lba * 512, 512);
  if (head.length < 512) return { error: 'past the end of the image' };
  let swapped;
  if ((be32(swap16(head), 0) >>> 16) === 0x1000) swapped = true;
  else if ((be32(head, 0) >>> 16) === 0x1000) swapped = false;
  else return { error: 'no OS image' };
  const h = swapped ? swap16(head) : head;
  const len = Math.max(be32(h, 0x0c), be32(h, 0x10)) * 4;
  if (!len || len > OS_SLOT_SECTORS * 512) return { error: `bad image length ${len}` };
  const raw = readAt(fd, lba * 512, Math.ceil(len / 512) * 512);
  const img = (swapped ? swap16(raw) : raw).subarray(0, len);
  try { return { swapped, img, info: osImageInfo(img) }; } catch (e) { return { error: e.message }; }
}

// builds in the ROM collection, by checksum and size
let index = null;
function findInCollection(img, info) {
  const dir = opt('collection', 'data/rom-collection');
  if (!index) {
    index = [];
    const walk = (d) => {
      let ents;
      try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === '_approm.o') {
          const fd = openSync(p, 'r');
          const h = readAt(fd, 0, 0x40);
          closeSync(fd);
          if (h.length === 0x40) index.push({ path: p, checksum: be32(h, 8), words: be32(h, 0x0c) });
        }
      }
    };
    walk(dir);
  }
  for (const c of index) {
    if (c.checksum !== info.checksum || c.words * 4 !== info.size) continue;
    const full = new Uint8Array(readFileSync(c.path));
    const n = Math.min(full.length, img.length, Math.max(info.size, info.codeSize));
    let same = true;
    for (let i = 0; i < n && same; i++) same = full[i] === img[i];
    if (same) return c.path;
  }
  return null;
}

const describe = (s) => s.error ? s.error
  : `build base ${s.info.base.toString(16)}, ${(s.info.size / 1048576).toFixed(2)} MB, checksum ${s.info.checksum.toString(16).padStart(8, '0')} ${s.info.checksumOk ? 'ok' : 'BAD'}` +
    (lptPatchInfo(s.img) ? `, LPT-patched (v${lptPatchInfo(s.img).version})` : ', not patched');

const fd0 = openSync(disk, 'r');
const slots = OS_SLOTS.map((lba) => ({ lba, ...readSlot(fd0, lba) }));
const orders = new Set(slots.filter((s) => !s.error).map((s) => s.swapped));
if (orders.size > 1) fail('the two OS slots disagree about byte order; is this a WebTV disk image?');
const swapped = orders.size ? [...orders][0] : true;
console.log(`${disk}: ${(fstatSync(fd0).size / 1e9).toFixed(2)} GB, ${swapped ? 'byte-swapped (ATA order)' : 'CPU byte order'}`);
slots.forEach((s, i) => {
  console.log(`  Browser ${i} (LBA ${s.lba}): ${describe(s)}`);
  if (!s.error && !isLptModemPatched(s.img)) {
    const found = findInCollection(s.img, s.info);
    s.source = found;
    console.log(`    ${found ? `= ${found}` : 'not found in the ROM collection (--patch finds what it needs by signature, or pass --syms)'}`);
  }
});
closeSync(fd0);

const build = opt('build');
if (!flag('patch') && !build && !flag('tier3')) process.exit(0);
if ([flag('patch'), !!build, flag('tier3')].filter(Boolean).length > 1) fail('use one of --patch, --build, --tier3');

// what to write: [{ lba, img, name }]
const writes = [];
if (build) {
  let img = new Uint8Array(readFileSync(build));
  if (!flag('no-patch')) {
    const sym = opt('syms', join(dirname(build), 'symbols.sym'));
    if (!existsSync(sym)) console.log(`  no symbols file (${sym}); finding the names by signature`);
    const r = patchLptBuild(img, existsSync(sym) ? readFileSync(sym) : null);
    for (const l of r.report) console.log(`  [lpt] ${l}`);
    img = r.image;
  }
  slots.forEach((s, i) => writes.push({ lba: OS_SLOTS[i], img, name: `Browser ${i}` }));
} else if (flag('tier3')) {
  const img = buildTier3();
  if (img.length / 512 > TIER3_SECTORS) fail('the tier-3 image is too big');
  writes.push({ lba: TIER3_LBA, img, name: 'the tier-3 area' });
  console.log(`  the bridge's loader as a tier-3 image: ${img.length} bytes at LBA ${TIER3_LBA}`);
} else {
  slots.forEach((s, i) => {
    const name = `Browser ${i}`;
    if (s.error) { console.log(`  ${name}: skipped (${s.error})`); return; }
    if (isLptModemPatched(s.img)) { console.log(`  ${name}: already patched`); return; }
    const sym = opt('syms') || (s.source && join(dirname(s.source), 'symbols.sym'));
    const haveSym = sym && existsSync(sym);
    try {
      const r = patchLptBuild(s.img, haveSym ? readFileSync(sym) : null);
      console.log(`  ${name}: patched with ${haveSym ? sym : 'names found by signature'}`);
      for (const l of r.report) console.log(`    [lpt] ${l}`);
      writes.push({ lba: OS_SLOTS[i], img: r.image, name });
    } catch (e) {
      console.log(`  ${name}: skipped (cannot patch: ${e.message})`);
    }
  });
}
if (!writes.length) fail('nothing to write');

let out = disk;
if (!flag('in-place')) {
  if (!outArg) fail('pass -o OUT.bin, or --in-place to change the image itself');
  if (existsSync(outArg) && !flag('force')) fail(`${outArg} exists (--force to overwrite)`);
  copyFileSync(disk, outArg);
  out = outArg;
}

// the tier-3 area as it was, all of it, raw: what a factory put there (a tier-3 diagnostics
// image?) is unknown, so it can be put back (dd it to LBA TIER3_LBA)
if (flag('tier3')) {
  const backup = `${out}.tier3-backup.bin`;
  if (existsSync(backup) && !flag('force')) fail(`${backup} exists (--force to overwrite)`);
  const b = Buffer.alloc(TIER3_SECTORS * 512), fdb = openSync(out, 'r');
  readSync(fdb, b, 0, b.length, TIER3_LBA * 512);
  closeSync(fdb);
  writeFileSync(backup, b);
  console.log(`  the tier-3 area as it was (${TIER3_SECTORS} sectors at LBA ${TIER3_LBA}, raw) saved to ${backup}`);
}

const fd = openSync(out, 'r+');
for (const { lba, img } of writes) {
  const info = osImageInfo(img);
  const len = Math.max(info.size, info.codeSize);
  if (Math.ceil(len / 512) > OS_SLOT_SECTORS) fail(`image too big for an OS slot`);
  const padded = new Uint8Array(Math.ceil(len / 512) * 512);
  padded.set(img.subarray(0, Math.min(len, img.length)));
  const bytes = swapped ? swap16(padded) : padded;
  writeSync(fd, bytes, 0, bytes.length, lba * 512);
}
closeSync(fd);

// read back
const fd2 = openSync(out, 'r');
let ok = true;
for (const { lba, img, name } of writes) {
  const s = readSlot(fd2, lba);
  const good = !s.error && s.info.checksumOk && s.img.length === Math.max(osImageInfo(img).size, osImageInfo(img).codeSize) &&
    s.img.every((b, k) => b === img[k]);
  ok = ok && good;
  console.log(`  wrote ${name}: ${good ? describe(s) : 'READ-BACK MISMATCH'}`);
}
closeSync(fd2);
if (!ok) fail('verification failed');
console.log(`done: ${out}`);
