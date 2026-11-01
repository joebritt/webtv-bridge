// Packs a raw WebTV disk image into the compact random-access "WTVDSK1" format used by the
// single-file build (and readable by web/packed-disk.js anywhere a disk image is accepted).
//
//   node tools/pack-disk.mjs data/debug_webtv_w200_7.bin data/debug_webtv_w200_7.wtvd
//
// Almost every sector of these images is a 4-byte counter stamp followed by zeros, so each
// sector is stored trimmed of trailing zeros, with short (<= 8 byte) sectors delta-coded
// against the previous short sector. Groups of GROUP sectors are compressed independently with
// raw deflate (which browsers decode natively), so any sector can be read without unpacking
// the rest.
//
// Layout (little-endian):
//   "WTVDSK1\0"  u32 sectorCount  u32 groupSectors  u32 groupCount
//   u32 offsets[groupCount + 1]   (byte offsets of each group's data, from the file start)
//   group data: deflate-raw( u16 len[n], then each sector's first len bytes )

import { openSync, readSync, writeFileSync, fstatSync, closeSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

export const MAGIC = 'WTVDSK1\0';
export const GROUP = 2048; // sectors (1 MB) per group
const SHORT = 8;

const [src, dst] = process.argv.slice(2);
if (!src || !dst) { console.error('usage: node tools/pack-disk.mjs IMAGE.bin OUT.wtvd'); process.exit(1); }

const fd = openSync(src, 'r');
const size = fstatSync(fd).size;
const sectorCount = Math.floor(size / 512);
const groupCount = Math.ceil(sectorCount / GROUP);
const chunks = [];
const buf = Buffer.alloc(GROUP * 512);
let rawData = 0;

for (let g = 0; g < groupCount; g++) {
  const first = g * GROUP, n = Math.min(GROUP, sectorCount - first);
  readSync(fd, buf, 0, n * 512, first * 512);
  const lens = Buffer.alloc(n * 2);
  const parts = [lens];
  const prev = new Uint8Array(SHORT); // delta base resets at each group, so groups stand alone
  for (let i = 0; i < n; i++) {
    const sec = buf.subarray(i * 512, i * 512 + 512);
    let len = 512;
    while (len > 0 && sec[len - 1] === 0) len--;
    lens.writeUInt16LE(len, i * 2);
    if (len <= SHORT) {
      const d = Buffer.alloc(len);
      for (let k = 0; k < len; k++) d[k] = (sec[k] - prev[k]) & 0xff;
      for (let k = 0; k < SHORT; k++) prev[k] = sec[k];
      parts.push(d);
    } else {
      parts.push(Buffer.from(sec.subarray(0, len)));
      rawData += 512;
    }
  }
  chunks.push(deflateRawSync(Buffer.concat(parts), { level: 9 }));
  if (g % 256 === 0) process.stdout.write(`\rgroup ${g}/${groupCount}`);
}
closeSync(fd);

const head = Buffer.alloc(8 + 12 + (groupCount + 1) * 4);
head.write(MAGIC, 0, 'latin1');
head.writeUInt32LE(sectorCount, 8);
head.writeUInt32LE(GROUP, 12);
head.writeUInt32LE(groupCount, 16);
let off = head.length;
for (let g = 0; g <= groupCount; g++) {
  head.writeUInt32LE(off, 20 + g * 4);
  if (g < groupCount) off += chunks[g].length;
}
writeFileSync(dst, Buffer.concat([head, ...chunks]));
console.log(`\r${src}: ${(size / 1048576).toFixed(0)} MB, ${sectorCount} sectors (${(rawData / 1048576).toFixed(1)} MB of real data) -> ${dst}: ${(off / 1048576).toFixed(2)} MB`);
