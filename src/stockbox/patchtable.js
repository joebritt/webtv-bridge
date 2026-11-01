// The bridge's patch table (tools/lptpatchtable.mjs writes it; WEBTV_LPT_BRIDGE.md §10.7): for
// each known OS build, the runs of words the LPT patch changes. The bridge identifies the OS it
// read into the box's RAM by the code checksum, the size and the ROM filesystem's sum, and
// writes that build's runs.

export const PATCH_TABLE_VERSION = 2;   // 2 added options (patch.js optionSites)

const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const hex = (v) => (v >>> 0).toString(16).padStart(8, '0');

// What the bridge checks, from an image's bytes (the build's `size` bytes):
//   code: header word 2, the checksum of the first `codeWords` words (word 2 left out)
//   fs:   the ROM filesystem trailer at the end: [length in words][sum of those words], the
//         words just below it ({ start, words, sum }), or null if the build has none ('NoFS')
// -> { key, code, codeWords, size, fs } or null if it isn't a build image
export function imageIdentity(img) {
  if (img.length < 0x40 || (be32(img, 0) >>> 16) !== 0x1000) return null;
  const size = be32(img, 0x0c) * 4, codeWords = be32(img, 0x10);
  if (size > img.length || size < 16) return null;
  const code = be32(img, 0x08);
  let fs = null;
  if (be32(img, 0x24) !== 0x4e6f4653) { // 'NoFS'
    const words = be32(img, size - 8), sum = be32(img, size - 4);
    const start = size - 8 - words * 4;
    if (words && start >= codeWords * 4) fs = { start, words, sum };
  }
  return { key: `${hex(code)}-${hex(size)}-${fs ? hex(fs.sum) : 'nofs'}`, code, codeWords, size, fs };
}
