// Installing a WebTV OS build (an "approm" image such as the collection's _approm.o files) into a
// disk's main firmware slot, the way the box's own flash-upgrade does.
//
// Images are stored in CPU (big-endian) order with a build header (see README "Disk layout"):
//   0x00 branch  0x08 checksum  0x0c build size in words  0x10 code size in words (checksummed)
//   0x14 version  0x30 build base address  0x34 flags
// On disk the image is byte-swapped per 16-bit word (ATA order) and starts at LBA 17411.

// The boot ROM keeps two 8 MB OS slots ("Browser 0" and "Browser 1") and a select block that
// says which to boot; installing writes both, so it doesn't matter which is selected.
export const OS_SLOTS = [1027, 17411];
export const OS_SLOT_SECTORS = 16384;
export const OS_SLOT_LBA = OS_SLOTS[1];

const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

export function osImageInfo(img) {
  if (img.length < 0x40 || (be32(img, 0) >>> 16) !== 0x1000) throw new Error('not a WebTV build image (no branch at the start)');
  const buildWords = be32(img, 0x0c), codeWords = be32(img, 0x10);
  let sum = 0;
  for (let o = 0; o < codeWords * 4 && o + 4 <= img.length; o += 4) if (o !== 8) sum = (sum + be32(img, o)) >>> 0;
  return {
    checksum: be32(img, 0x08), checksumOk: sum === be32(img, 0x08),
    size: buildWords * 4, codeSize: codeWords * 4,
    version: be32(img, 0x14), base: be32(img, 0x30), flags: be32(img, 0x34),
  };
}

// -> Map(lba -> Uint8Array(512)) in disk (byte-swapped) order, ready for an OverlayDisk
export function osInstallSectors(img, slots = OS_SLOTS) {
  const info = osImageInfo(img);
  const len = Math.min(img.length, Math.max(info.size, info.codeSize));
  const sectors = Math.ceil(len / 512);
  if (sectors > OS_SLOT_SECTORS) throw new Error(`image too big for an OS slot (${sectors} sectors)`);
  const out = new Map();
  for (const lba of slots) for (let s = 0; s < sectors; s++) {
    const sec = new Uint8Array(512);
    const src = img.subarray(s * 512, Math.min(len, s * 512 + 512));
    for (let i = 0; i + 1 < src.length; i += 2) { sec[i] = src[i + 1]; sec[i + 1] = src[i]; }
    if (src.length & 1) sec[src.length] = src[src.length - 1]; // (never happens: sizes are words)
    out.set(lba + s, sec);
  }
  return { info, sectors: out };
}
