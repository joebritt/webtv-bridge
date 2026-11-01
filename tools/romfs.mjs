// List, extract and replace files in the ROM filesystem of a WebTV OS build image (_approm.o).
//
//   node tools/romfs.mjs IMAGE ls                              every file: size, compressed, path
//   node tools/romfs.mjs IMAGE get PATH [-o FILE]              extract (expanded) to FILE or stdout
//   node tools/romfs.mjs IMAGE put PATH FILE -o OUT            replace a file, write a new image
//
// PATH is the path under file://ROM/, e.g. HTMLs/ConfigureBYOISP.html (case-insensitive).
// The format is described in src/machine/romfs.js.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readRomfs, getFile, putFile, findFile, storedLen, method, byteSum, wordSum, be32 } from '../src/machine/romfs.js';

{
  const args = process.argv.slice(2);
  const oi = args.indexOf('-o');
  const out = oi >= 0 ? args.splice(oi, 2)[1] : null;
  const [image, cmd, path, file] = args;
  const fail = (m) => { console.error(m); process.exit(1); };
  if (!image || !cmd) fail('usage: node tools/romfs.mjs IMAGE ls | get PATH [-o FILE] | put PATH FILE -o OUT');
  const img = new Uint8Array(readFileSync(image));
  const fs = readRomfs(img);
  if (cmd === 'ls') {
    const sumOk = wordSum(img, fs.start, fs.end - 8) === be32(img, fs.end - 4);
    console.log(`ROMFS ${(fs.info.base + fs.start).toString(16)}-${(fs.info.base + fs.end).toString(16)}, ${fs.files.length} files, trailer sum ${sumOk ? 'ok' : 'BAD'}, ${fs.start - fs.info.codeSize} bytes free below it`);
    for (const f of fs.files) {
      const n = storedLen(f);
      const ok = byteSum(img.subarray(fs.off(f.data), fs.off(f.data) + n)) === f.sum;
      console.log(`${String(n).padStart(8)} ${method(f)} ${ok ? '  ' : '!!'} ${f.path}`);
    }
  } else if (cmd === 'get') {
    const f = fs.files.find((x) => x.path.toLowerCase() === (path || '').toLowerCase());
    if (!f) fail(`no ${path} in the ROMFS`);
    const data = getFile(img, fs, f);
    if (out) writeFileSync(out, data); else process.stdout.write(data);
  } else if (cmd === 'put') {
    if (!path || !file || !out) fail('usage: node tools/romfs.mjs IMAGE put PATH FILE -o OUT');
    if (existsSync(out) && out !== image) console.error(`(overwriting ${out})`);
    const r = putFile(img, path, new Uint8Array(readFileSync(file)));
    writeFileSync(out, r.image);
    // check the result reads back
    const fs2 = readRomfs(r.image);
    const f2 = fs2.files.find((x) => x.path.toLowerCase() === path.toLowerCase());
    const back = getFile(r.image, fs2, f2);
    const same = back.length === readFileSync(file).length && back.every((b, i) => b === readFileSync(file)[i]);
    console.log(`${f2.path}: ${r.before} -> ${r.after} bytes stored, ${r.note}; reads back ${same ? 'ok' : 'WRONG'}`);
    if (!same) process.exit(1);
  } else fail(`unknown command ${cmd}`);
}
