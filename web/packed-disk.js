// Reader for the "WTVDSK1" packed disk format written by tools/pack-disk.mjs: random access
// to a compressed WebTV disk image, decoding groups of sectors on demand with the browser's
// built-in raw-deflate decompressor (DecompressionStream) and keeping recent groups cached.

const MAGIC = 'WTVDSK1\0';
const SHORT = 8;

export function isPackedDisk(bytes) {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class PackedDisk {
  // bytes: the whole .wtvd file (Uint8Array)
  constructor(bytes, { cacheGroups = 64 } = {}) {
    if (!isPackedDisk(bytes)) throw new Error('not a WTVDSK1 packed disk');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.bytes = bytes;
    this.sectorCount = dv.getUint32(8, true);
    this.groupSectors = dv.getUint32(12, true);
    this.groupCount = dv.getUint32(16, true);
    this.offsets = new Uint32Array(this.groupCount + 1);
    for (let g = 0; g <= this.groupCount; g++) this.offsets[g] = dv.getUint32(20 + g * 4, true);
    this.size = this.sectorCount * 512;
    this.cache = new Map();   // group -> decoded sectors (Uint8Array), in LRU order
    this.pending = new Map(); // group -> Promise of decoded sectors, while decoding
    this.cacheGroups = cacheGroups;
  }

  // Decoded group if it is cached (refreshing its LRU position), else undefined.
  cached(g) {
    const d = this.cache.get(g);
    if (d) { this.cache.delete(g); this.cache.set(g, d); }
    return d;
  }

  // Promise of a decoded group; decodes each group once even if asked for repeatedly.
  load(g) {
    let p = this.pending.get(g);
    if (!p) {
      p = this.decode(g).then((d) => {
        this.pending.delete(g);
        this.cache.set(g, d);
        if (this.cache.size > this.cacheGroups) this.cache.delete(this.cache.keys().next().value);
        return d;
      });
      this.pending.set(g, p);
    }
    return p;
  }

  async decode(g) {
    const first = g * this.groupSectors;
    const n = Math.min(this.groupSectors, this.sectorCount - first);
    const raw = await inflateRaw(this.bytes.subarray(this.offsets[g], this.offsets[g + 1]));
    const out = new Uint8Array(n * 512);
    const prev = new Uint8Array(SHORT);
    let pos = n * 2;
    for (let i = 0; i < n; i++) {
      const len = raw[i * 2] | (raw[i * 2 + 1] << 8);
      const o = i * 512;
      if (len <= SHORT) {
        for (let k = 0; k < len; k++) out[o + k] = (raw[pos + k] + prev[k]) & 0xff;
        for (let k = 0; k < SHORT; k++) prev[k] = out[o + k];
      } else {
        out.set(raw.subarray(pos, pos + len), o);
      }
      pos += len;
    }
    return out;
  }

  // (lba, count) -> Uint8Array, or a Promise of one if a group still has to be decoded (the
  // OverlayDisk read function shape). Cached reads are synchronous so the CPU never waits for
  // an event-loop turn on them.
  read(lba, count) {
    const groups = [];
    const last = Math.min(this.sectorCount, lba + count) - 1;
    for (let g = Math.floor(lba / this.groupSectors); g <= Math.floor(last / this.groupSectors); g++) {
      const d = this.cached(g);
      if (!d) return this.readAsync(lba, count);
      groups.push([g, d]);
    }
    return this.copy(lba, count, new Map(groups));
  }

  async readAsync(lba, count) {
    const last = Math.min(this.sectorCount, lba + count) - 1;
    const groups = new Map();
    for (let g = Math.floor(lba / this.groupSectors); g <= Math.floor(last / this.groupSectors); g++) {
      groups.set(g, this.cached(g) || await this.load(g));
    }
    return this.copy(lba, count, groups);
  }

  copy(lba, count, groups) {
    const out = new Uint8Array(count * 512);
    let s = lba, o = 0;
    while (o < out.length && s < this.sectorCount) {
      const g = Math.floor(s / this.groupSectors);
      const data = groups.get(g);
      const off = (s - g * this.groupSectors) * 512;
      const n = Math.min(out.length - o, data.length - off);
      out.set(data.subarray(off, off + n), o);
      o += n; s += n / 512;
    }
    return out;
  }
}
