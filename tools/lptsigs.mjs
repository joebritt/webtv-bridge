#!/usr/bin/env node
// Signatures for the LPT patch (src/lptmodem/sigs.js): learn them from the ROM collection's
// builds with symbols, test them, and use them on builds without.
//
//   node tools/lptsigs.mjs build [-o src/lptmodem/sigdb.json]
//       learn from every collection build with symbols.sym
//   node tools/lptsigs.mjs test [--only SUBSTR] [-v]
//       leave-one-out: for each build with symbols, learn from all the others (leaving out
//       every build with the same image), recover its symbols from the code alone, compare
//       them with symbols.sym, then patch both ways and compare the images byte for byte
//   node tools/lptsigs.mjs recover <_approm.o> [--db FILE]
//       what the signatures find in one image
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { osImageInfo } from '../src/machine/osinstall.js';
import { symbolSource, patchLptModem, startsAfter, FUNCS, DATA, OPTIONAL } from '../src/lptmodem/patch.js';
import { learnBuild, buildDb, withoutBuilds, packDb, unpackDb, recoverSymbols } from '../src/lptmodem/sigs.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const COLLECTION = 'data/rom-collection';
const DB_FILE = 'src/lptmodem/sigdb.json';
const NAMES = [...FUNCS, ...DATA, ...OPTIONAL];

// every _approm.o under the collection, with its symbols.sym if it has one
function collection() {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e === '_approm.o') out.push({ img: p, sym: existsSync(join(d, 'symbols.sym')) ? join(d, 'symbols.sym') : null, id: d.slice(COLLECTION.length + 1) });
    }
  };
  walk(COLLECTION);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function learnAll() {
  const learned = [];
  for (const b of collection()) {
    if (!b.sym) continue;
    const img = new Uint8Array(readFileSync(b.img));
    let info;
    try { info = osImageInfo(img); } catch { continue; }
    const S = symbolSource(readFileSync(b.sym), img);
    // symbols that don't fit the image (daily-debug 3833) would teach nonsense
    const w = (a) => ((img[a - info.base] << 24) | (img[a - info.base + 1] << 16) | (img[a - info.base + 2] << 8) | img[a - info.base + 3]) >>> 0;
    const fits = FUNCS.every((n) => { if (!S.has(n)) return true; const a = S.addr(n); return a - 8 >= info.base && a < info.base + info.codeSize && startsAfter(w(a - 8), w(a - 4)); });
    if (!fits) { console.log(`not learning from ${b.id}: its symbols don't fit its code`); continue; }
    const hash = createHash('sha1').update(img).digest('hex');
    learned.push({ ...b, image: img, info, S, hash, ...learnBuild(img, info, S, NAMES, [...DATA, 'gCharIOSelect']) });
  }
  return learned;
}

const cmd = args[0];
if (cmd === 'build') {
  const learned = learnAll();
  const db = buildDb(learned);
  const packed = packDb(db);
  const out = opt('-o', DB_FILE);
  writeFileSync(out, JSON.stringify(packed));
  const nv = Object.values(db.fns).reduce((s, e) => s + e.variants.length, 0);
  console.log(`learned ${Object.keys(db.fns).length} functions (${nv} variants) from ${learned.length} builds -> ${out} (${(JSON.stringify(packed).length / 1024).toFixed(0)} KB)`);
} else if (cmd === 'test') {
  const verbose = args.includes('-v');
  const learned = learnAll();
  const db = buildDb(learned);
  const only = opt('--only');
  let pass = 0, fail = 0, refused = 0, missing = {}, wrong = {};
  for (const b of learned) {
    if (only && !b.id.includes(only)) continue;
    // leave out this build and every identical one
    const twins = learned.filter((x) => x.hash === b.hash).map((x) => x.id);
    const rec = recoverSymbols(b.image, b.info, withoutBuilds(db, twins));
    // names: compare with the truth
    const bad = [];
    for (const n of NAMES) {
      const truth = b.S.has(n) ? b.S.addr(n) : null;
      const got = rec.has(n) ? rec.addr(n) : null;
      if (truth !== null && got === null) { (missing[n] = missing[n] || []).push(b.id); }
      else if (got !== null && got !== truth) { bad.push(`${n} ${got.toString(16)} (is ${truth?.toString(16)})`); (wrong[n] = wrong[n] || []).push(b.id); }
    }
    // the patch: by symbols and by signatures, byte for byte
    let verdict;
    let bySym = null, bySig = null;
    try { bySym = patchLptModem(b.image, readFileSync(b.sym)); } catch (e) { bySym = { error: e.message }; }
    try { bySig = patchLptModem(b.image, rec); } catch (e) { bySig = { error: e.message }; }
    if (bySym.error && bySig.error) { verdict = `both refuse (${bySig.error})`; refused++; }
    else if (bySig.error) { verdict = `FAIL: signatures can't patch: ${bySig.error}`; fail++; }
    else if (bySym.error) { verdict = `FAIL: only the signatures patch (${bySym.error})`; fail++; }
    else if (Buffer.compare(Buffer.from(bySym.image), Buffer.from(bySig.image)) !== 0) {
      let first = 0; while (bySym.image[first] === bySig.image[first]) first++;
      verdict = `FAIL: images differ from offset ${first.toString(16)}`; fail++;
    } else { verdict = 'ok, identical'; pass++; }
    if (bad.length) verdict += `; WRONG ${bad.join(', ')}`;
    if (verbose || !verdict.startsWith('ok') || bad.length) console.log(`${b.id}: ${verdict}  [${rec.report[0].replace('symbols recovered from signatures: ', '')}]${rec.report.length > 1 ? ' ' + rec.report.slice(1).join('; ') : ''}`);
  }
  console.log(`\n${pass} identical, ${fail} failed, ${refused} refused either way`);
  if (Object.keys(wrong).length) console.log('wrong:', Object.entries(wrong).map(([n, l]) => `${n} ${l.length}`).join(', '));
  if (Object.keys(missing).length) console.log('not found (in builds that have them):', Object.entries(missing).map(([n, l]) => `${n} ${l.length}`).join(', '));
} else if (cmd === 'recover') {
  const img = new Uint8Array(readFileSync(args[1]));
  const db = unpackDb(JSON.parse(readFileSync(opt('--db', DB_FILE), 'utf8')));
  const rec = recoverSymbols(img, osImageInfo(img), db);
  for (const l of rec.report) console.log(l);
  for (const [a, n] of rec.list) console.log(`  ${a.toString(16)} ${n} (${rec.how[n]})`);
} else {
  console.log('usage: lptsigs.mjs build | test [--only SUBSTR] [-v] | recover <_approm.o>');
  process.exit(2);
}
