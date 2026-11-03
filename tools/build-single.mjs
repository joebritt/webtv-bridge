// Builds dist/webtv.html: the whole emulator in one self-contained HTML file (code, styles,
// boot ROM, packed disk image and README), to share or open straight from disk.
//
//   node tools/build-single.mjs [--rom data/flipped_merged_boot.bin]
//                               [--disk data/debug_webtv_w200_7.bin] [--out dist/webtv.html]
//
// The disk is embedded in the packed WTVDSK1 format (tools/pack-disk.mjs; packed first if the
// .wtvd is missing or older than the image) and the ROM gzipped, both base64-encoded. The page
// and worker code are bundled with esbuild; main.js picks up the embedded pieces through
// window.WEBTV_EMBED. There is no minisrv in this build: the box runs offline, or reaches a
// service through whatever relay URL the user enters.

import { build } from 'esbuild';
import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const romPath = resolve(root, opt('rom', 'data/flipped_merged_boot.bin'));
const diskPath = resolve(root, opt('disk', 'data/debug_webtv_w200_7.bin'));
const outPath = resolve(root, opt('out', 'dist/webtv.html'));

// ---------------------------------------------------------------- data

let packedPath = diskPath;
if (!diskPath.endsWith('.wtvd')) {
  packedPath = diskPath.replace(/\.[^./]+$/, '') + '.wtvd';
  if (!existsSync(packedPath) || statSync(packedPath).mtimeMs < statSync(diskPath).mtimeMs) {
    execFileSync(process.execPath, [join(root, 'tools/pack-disk.mjs'), diskPath, packedPath], { stdio: 'inherit' });
  }
}
const rom = gzipSync(readFileSync(romPath), { level: 9 });
const disk = readFileSync(packedPath);
const name = (p) => basename(p).replace(/\.[^.]+$/, '');

// ---------------------------------------------------------------- code

async function bundle(entry) {
  const r = await build({
    entryPoints: [join(root, entry)], bundle: true, write: false, format: 'iife',
    minify: true, target: 'es2022', logLevel: 'error', logOverride: { 'empty-import-meta': 'silent' },
  });
  return r.outputFiles[0].text;
}
const [mainJs, workerJs] = await Promise.all([bundle('web/main.js'), bundle('web/worker.js')]);
const workletJs = readFileSync(join(root, 'web/audio-worklet.js'), 'utf8');
const css = readFileSync(join(root, 'web/style.css'), 'utf8');
const readme = readFileSync(join(root, 'README.md'), 'utf8');

// text inside <script> must not close the element early
const scriptSafe = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const dataTag = (id, type, text) => `<script type="${type}" id="${id}">${scriptSafe(text)}</script>`;

let html = readFileSync(join(root, 'web/index.html'), 'utf8');
html = html.replace('<link rel="stylesheet" href="style.css">', () => `<style>\n${css}</style>`);
const embed = { romName: name(romPath), diskName: name(diskPath) };
html = html.replace('<script type="module" src="main.js"></script>', () => [
  dataTag('embed-rom', 'application/octet-stream', rom.toString('base64')),
  dataTag('embed-disk', 'application/octet-stream', disk.toString('base64')),
  dataTag('embed-worker', 'text/plain', workerJs),
  dataTag('embed-worklet', 'text/plain', workletJs),
  dataTag('embed-readme', 'text/markdown', readme),
  `<script>window.WEBTV_EMBED = ${JSON.stringify(embed)};</script>`,
  `<script>${scriptSafe(mainJs)}</script>`,
].join('\n'));
if (html.includes('src="main.js"') || html.includes('href="style.css"')) throw new Error('index.html changed: update build-single.mjs');

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html);
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
console.log(`${outPath}: ${mb(html.length)} (disk ${mb(disk.length)}, ROM ${mb(rom.length)}, code ${mb(mainJs.length + workerJs.length + workletJs.length)}; base64 adds a third)`);
