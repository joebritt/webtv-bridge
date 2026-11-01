// A WebTV Plus disk: the partition table, the fixed areas, and the FAT filesystems in it, read
// and (given a writer) written: files written, replaced and deleted, folders made. The
// emulator's disk browser (disk-browser.js) reads with it; the Bridge's web page (pico/web/,
// where tools/webgen.mjs inlines this file) reads and writes the real box's disk through the
// Bridge's /disk, which gives sectors in the CPU's byte order (swapped: false).
//
// Layout (worked out from the 1997 debug image; see README "Disk layout"):
//   - The CPU sees the disk through ATA 16-bit words, so every pair of bytes in the image file
//     is swapped relative to what the OS reads. Everything below is in the CPU's byte order.
//   - LBA 1-14: NV storage (a second copy at LBA 33796). OS build images live in the boot
//     partition (e.g. LBA 512 and 17411), each starting with a header (branch, 0, checksum,
//     0x00100000, length in words, ...).
//   - Partition table: 2 KB at LBA 42504 (0xa608); LBA 34312 (0x8608) holds an older layout.
//     u32 checksum (byte sum of bytes 4..2047), u32 count, then 52-byte entries starting at
//     offset 0xc: name[32], start, size (sectors), type, flags, timestamp (big-endian). The
//     first entry's name overlaps the magic: "timn" + "boot".
//     Types seen: 3 boot, 0 free, 2 filesystem. Each partition's first sector repeats its entry
//     as "part<name>" with the same checksum scheme.
//   - Type-2 partitions hold a FAT16 filesystem (OEM "WebTV   ", little-endian as usual, VFAT
//     long names) whose boot sector is 32 sectors into the partition.

export const TABLE_LBAS = [42504, 34312];

// Areas of the boot partition outside the filesystems, where the boot ROM and the Bridge find
// them (pico/src/sb/sb_ramboot.c, src/stockbox/tier3.js)
export const FIXED_AREAS = [
  { name: 'NV storage', start: 1, size: 14 },
  { name: 'OS slot 0 ("Browser 0")', start: 1027, size: 16384, os: true },
  { name: 'OS slot 1 ("Browser 1")', start: 17411, size: 16384, os: true },
  { name: 'Select block (which OS slot boots)', start: 33795, size: 1 },
  { name: 'NV storage, second copy', start: 33796, size: 14 },
  { name: 'Tier-3 area (the Bridge\'s loader)', start: 34312, size: 8192 },
  { name: 'Partition table', start: 42504, size: 4 },
];

const swap16 = (b) => {
  const o = new Uint8Array(b.length);
  for (let i = 0; i + 1 < b.length; i += 2) { o[i] = b[i + 1]; o[i + 1] = b[i]; }
  return o;
};
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const le16 = (b, o) => b[o] | (b[o + 1] << 8);
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const put16 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };
const put32 = (b, o, v) => { put16(b, o, v & 0xffff); put16(b, o + 2, (v >>> 16) & 0xffff); };
const cstr = (b, o, n) => { let s = ''; for (let i = 0; i < n && b[o + i]; i++) s += String.fromCharCode(b[o + i]); return s; };
const byteSum = (b, from, to) => { let s = 0; for (let i = from; i < to; i++) s += b[i]; return s >>> 0; };

export const PART_TYPES = { 0: 'free', 2: 'filesystem', 3: 'boot' };

export class WebTVDisk {
  // readRaw(lba, count) -> Uint8Array | Promise<Uint8Array>; writeRaw(lba, bytes) -> Promise, or
  // none (read-only). swapped: the source's byte pairs are swapped from the CPU's (an image file)
  constructor(readRaw, sectorCount, { swapped = true, writeRaw = null } = {}) {
    this.readRaw = readRaw;
    this.writeRaw = writeRaw;
    this.swapped = swapped;
    this.sectorCount = sectorCount;
  }

  get writable() { return !!this.writeRaw; }
  async read(lba, count = 1) { const b = await this.readRaw(lba, count); return this.swapped ? swap16(b) : b; }
  async write(lba, bytes) {
    if (!this.writeRaw) throw new Error('this disk is read-only');
    if (bytes.length % 512) throw new Error('writes are whole sectors');
    await this.writeRaw(lba, this.swapped ? swap16(bytes) : bytes);
  }

  async partitions() {
    for (const lba of TABLE_LBAS) {
      const t = await this.read(lba, 4);
      if (cstr(t, 8, 8) !== 'timnboot' || byteSum(t, 4, 2048) !== be32(t, 0)) continue;
      const count = be32(t, 4), parts = [];
      for (let k = 0; k < count && 0xc + (k + 1) * 0x34 <= 2048; k++) {
        const o = 0xc + k * 0x34;
        const start = be32(t, o + 32), size = be32(t, o + 36), type = be32(t, o + 40);
        parts.push({ index: k, name: k === 0 ? 'boot' : cstr(t, o, 32), start, size, type, flags: be32(t, o + 44), stamp: be32(t, o + 48) });
      }
      return { tableLba: lba, parts };
    }
    return { tableLba: null, parts: [] };
  }

  // FAT filesystem of a partition, or null
  async openFat(part) {
    for (let off = 0; off < 64 && off < part.size; off++) {
      const bs = await this.read(part.start + off);
      if (bs[0] === 0xeb && le16(bs, 11) === 512 && bs[13] && bs[16]) return new FatFs(this, part.start + off, bs);
    }
    return null;
  }
}

// 8.3 names: what a short name may hold
const SFN_OK = /^[A-Z0-9!#$%&'()\-@^_`{}~]$/;
const sfnChecksum = (sfn) => { let s = 0; for (let i = 0; i < 11; i++) s = (((s & 1) << 7) | (s >> 1)) + sfn[i] & 0xff; return s; };
const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

export class FatFs {
  constructor(disk, bootLba, bs) {
    this.disk = disk;
    this.bootLba = bootLba;
    this.oem = cstr(bs, 3, 8).trim();
    this.label = cstr(bs, 43, 11).trim();
    this.spc = bs[13];
    const reserved = le16(bs, 14);
    this.nfats = bs[16];
    this.rootEntries = le16(bs, 17);
    this.fatSectors = le16(bs, 22);
    this.totalSectors = le16(bs, 19) || le32(bs, 32);
    this.fatLba = bootLba + reserved;
    this.rootLba = this.fatLba + this.nfats * this.fatSectors;
    this.rootSectors = Math.ceil(this.rootEntries * 32 / 512);
    this.dataLba = this.rootLba + this.rootSectors;
    this.clusters = Math.floor((this.totalSectors - (this.dataLba - bootLba)) / this.spc);
    this.fat12 = this.clusters < 4085;
    this.fat = null;
    this.fatDirty = new Set();
  }

  get clusterBytes() { return this.spc * 512; }
  clusterLba(c) { return this.dataLba + (c - 2) * this.spc; }

  // the FAT is read once; forget() makes the next operation read it afresh (someone else may
  // have written the disk meanwhile)
  forget() { this.fat = null; this.fatDirty.clear(); }

  async loadFat() {
    if (!this.fat) this.fat = await this.disk.read(this.fatLba, this.fatSectors);
    return this.fat;
  }

  raw(c) {
    const f = this.fat;
    if (this.fat12) { const v = le16(f, c + (c >> 1)); return c & 1 ? v >> 4 : v & 0xfff; }
    return le16(f, c * 2);
  }

  next(c) {
    const n = this.raw(c);
    return n >= (this.fat12 ? 0xff8 : 0xfff8) ? -1 : n;
  }

  setNext(c, v) {
    const f = this.fat;
    if (this.fat12) {
      const o = c + (c >> 1), w = le16(f, o);
      put16(f, o, c & 1 ? (w & 0x000f) | ((v & 0xfff) << 4) : (w & 0xf000) | (v & 0xfff));
      this.fatDirty.add(o >> 9); this.fatDirty.add((o + 1) >> 9);
    } else {
      put16(f, c * 2, v);
      this.fatDirty.add((c * 2) >> 9);
    }
  }

  get eoc() { return this.fat12 ? 0xfff : 0xffff; }

  async chain(first) {
    await this.loadFat();
    const out = [];
    for (let c = first; c >= 2 && c < this.clusters + 2 && out.length <= this.clusters; c = this.next(c)) out.push(c);
    return out;
  }

  async freeClusters() {
    await this.loadFat();
    let n = 0;
    for (let c = 2; c < this.clusters + 2; c++) if (!this.raw(c)) n++;
    return n;
  }

  // consecutive clusters as one transfer each: [[firstLba, sectors, offsetInClusters], ...]
  runs(cl) {
    const out = [];
    for (let i = 0; i < cl.length; i++) {
      const last = out[out.length - 1];
      if (last && cl[i] === cl[i - 1] + 1) last[1] += this.spc;
      else out.push([this.clusterLba(cl[i]), this.spc, i]);
    }
    return out;
  }

  async readClusters(first, limitBytes = Infinity) {
    const all = await this.chain(first);
    const per = this.clusterBytes;
    const cl = all.slice(0, Math.min(all.length, Math.ceil(limitBytes / per)));
    const out = new Uint8Array(cl.length * per);
    for (const [lba, n, at] of this.runs(cl)) out.set(await this.disk.read(lba, n), at * per);
    return out;
  }

  // a directory's entries with where they are: { buf, lbas (one per sector), chain (null: the root) }
  async dirArea(dir) {
    if (!dir) {
      const buf = await this.disk.read(this.rootLba, this.rootSectors);
      return { buf, lbas: Array.from({ length: this.rootSectors }, (_, i) => this.rootLba + i), chain: null };
    }
    const chain = await this.chain(dir.cluster);
    const buf = await this.readClusters(dir.cluster);
    const lbas = [];
    for (const c of chain) for (let i = 0; i < this.spc; i++) lbas.push(this.clusterLba(c) + i);
    return { buf, lbas, chain };
  }

  parse(buf) {
    const out = [];
    let lfn = '', lfnStart = -1;
    for (let i = 0; i + 32 <= buf.length; i += 32) {
      const e = buf.subarray(i, i + 32);
      if (e[0] === 0) break;
      if (e[0] === 0xe5) { lfn = ''; lfnStart = -1; continue; }
      const attr = e[11];
      if (attr === 0x0f) {
        let part = '';
        for (const [o, n] of [[1, 5], [14, 6], [28, 2]]) {
          for (let k = 0; k < n; k++) {
            const ch = le16(e, o + k * 2);
            if (ch === 0 || ch === 0xffff) { k = n; break; }
            part += String.fromCharCode(ch);
          }
        }
        if (e[0] & 0x40) { lfn = part; lfnStart = i / 32; } else lfn = part + lfn;
        continue;
      }
      if (attr & 0x08) { lfn = ''; lfnStart = -1; continue; } // volume label
      const base = cstr(e, 0, 8).trimEnd(), ext = cstr(e, 8, 3).trimEnd();
      const short = ext ? `${base}.${ext}` : base;
      const name = lfn || short;
      const time = le16(e, 22), date = le16(e, 24);
      out.push({
        name, short, isDir: !!(attr & 0x10), attr,
        cluster: le16(e, 26), size: le32(e, 28),
        date: date ? new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2) : null,
        slot: i / 32, first: lfn && lfnStart >= 0 ? lfnStart : i / 32,
      });
      lfn = ''; lfnStart = -1;
    }
    return out;
  }

  // dir: null for the root, or an entry from list()
  async list(dir = null) {
    const { buf } = await this.dirArea(dir);
    const out = this.parse(buf).filter((e) => e.name !== '.' && e.name !== '..');
    out.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    return out;
  }

  async readFile(entry, limit = Infinity) {
    if (!entry.size) return new Uint8Array(0);
    const n = Math.min(entry.size, limit);
    return (await this.readClusters(entry.cluster, n)).subarray(0, n);
  }

  // ---------------------------------------------------------------- writing

  async flushFat() {
    const dirty = [...this.fatDirty].filter((s) => s < this.fatSectors).sort((a, b) => a - b);
    this.fatDirty.clear();
    for (let i = 0; i < dirty.length;) {
      let j = i;
      while (j + 1 < dirty.length && dirty[j + 1] === dirty[j] + 1) j++;
      const from = dirty[i], n = dirty[j] - from + 1;
      const bytes = this.fat.slice(from * 512, (from + n) * 512);
      for (let k = 0; k < this.nfats; k++) await this.disk.write(this.fatLba + k * this.fatSectors + from, bytes);
      i = j + 1;
    }
  }

  // n free clusters, linked into a chain (not yet written)
  alloc(n, after = 0) {
    const got = [];
    for (let c = 2; c < this.clusters + 2 && got.length < n; c++) if (!this.raw(c)) got.push(c);
    if (got.length < n) throw new Error(`not enough room: ${n} clusters wanted, ${got.length} free`);
    got.forEach((c, i) => this.setNext(c, i + 1 < got.length ? got[i + 1] : this.eoc));
    if (after) this.setNext(after, got[0]);
    return got;
  }

  freeChainOf(cl) { for (const c of cl) this.setNext(c, 0); }

  async writeClusters(cl, data) {
    const per = this.clusterBytes;
    for (const [lba, n, at] of this.runs(cl)) {
      const bytes = new Uint8Array(n * 512);
      bytes.set(data.subarray(at * per, Math.min(data.length, at * per + n * 512)));
      await this.disk.write(lba, bytes);
    }
  }

  async writeDirSectors(area, from, to) {
    // the sectors holding entries [from, to)
    const s0 = (from * 32) >> 9, s1 = ((to * 32) - 1) >> 9;
    for (let s = s0; s <= s1; s++) await this.disk.write(area.lbas[s], area.buf.slice(s * 512, s * 512 + 512));
  }

  find(area, name) {
    const lc = name.toLowerCase();
    return this.parse(area.buf).find((e) => e.name.toLowerCase() === lc || e.short.toLowerCase() === lc) || null;
  }

  // a unique 8.3 name for `name`, and whether it needs long-name entries
  shortName(area, name) {
    const taken = new Set(this.parse(area.buf).map((e) => e.short));
    const up = name.toUpperCase();
    const dot = up.lastIndexOf('.');
    const clean = (s) => [...s.replace(/ /g, '')].map((ch) => (SFN_OK.test(ch) ? ch : '_')).join('');
    let base = clean(dot > 0 ? up.slice(0, dot) : up).replace(/\./g, ''), ext = dot > 0 ? clean(up.slice(dot + 1)).slice(0, 3) : '';
    const exact = name === (ext ? `${base}.${ext}` : base) && base.length && base.length <= 8 && !taken.has(name);
    if (exact) return { sfn: name, lfn: false };
    if (!base) base = '_';
    for (let k = 1; k < 1000000; k++) {
      const tail = `~${k}`;
      const cand = base.slice(0, 8 - tail.length) + tail;
      const full = ext ? `${cand}.${ext}` : cand;
      if (!taken.has(full)) return { sfn: full, lfn: true };
    }
    throw new Error('no short name left');
  }

  makeEntries(name, sfn, lfn, attr, cluster, size, when = new Date()) {
    const s = new Uint8Array(32).fill(0x20, 0, 11);
    const [b, x = ''] = sfn.split('.');
    for (let i = 0; i < b.length; i++) s[i] = b.charCodeAt(i);
    for (let i = 0; i < x.length; i++) s[8 + i] = x.charCodeAt(i);
    s[11] = attr;
    put16(s, 14, dosTime(when)); put16(s, 16, dosDate(when)); put16(s, 18, dosDate(when));
    put16(s, 22, dosTime(when)); put16(s, 24, dosDate(when));
    put16(s, 26, cluster); put32(s, 28, size);
    if (!lfn) return [s];
    const sum = sfnChecksum(s), units = [...name].map((c) => c.charCodeAt(0) & 0xffff);
    const n = Math.ceil(units.length / 13), out = [];
    for (let k = n; k >= 1; k--) {
      const e = new Uint8Array(32);
      e[0] = k | (k === n ? 0x40 : 0); e[11] = 0x0f; e[13] = sum;
      const pos = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
      for (let i = 0; i < 13; i++) {
        const j = (k - 1) * 13 + i;
        put16(e, pos[i], j < units.length ? units[j] : j === units.length ? 0 : 0xffff);
      }
      out.push(e);
    }
    out.push(s);
    return out;
  }

  // room for `count` entries in a row: the index of the first, growing a folder if it must
  async room(area, count) {
    const total = area.buf.length / 32;
    for (let i = 0; i < total; i++) {
      let j = i;
      while (j < total && j - i < count && (area.buf[j * 32] === 0 || area.buf[j * 32] === 0xe5)) j++;
      if (j - i >= count) return i;
      i = j;
    }
    if (!area.chain) throw new Error('the root folder is full');
    const [c] = this.alloc(1, area.chain[area.chain.length - 1]);
    await this.writeClusters([c], new Uint8Array(this.clusterBytes));
    const buf = new Uint8Array(area.buf.length + this.clusterBytes);
    buf.set(area.buf);
    area.buf = buf;
    area.chain.push(c);
    for (let i = 0; i < this.spc; i++) area.lbas.push(this.clusterLba(c) + i);
    return this.room(area, count);
  }

  async addEntry(area, name, attr, cluster, size) {
    const { sfn, lfn } = this.shortName(area, name);
    const ents = this.makeEntries(name, sfn, lfn, attr, cluster, size);
    const at = await this.room(area, ents.length);
    ents.forEach((e, i) => area.buf.set(e, (at + i) * 32));
    await this.flushFat();                       // any new folder cluster first
    await this.writeDirSectors(area, at, at + ents.length);
  }

  checkName(name) {
    if (!name || name === '.' || name === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(name) || name.length > 255) throw new Error(`"${name}" can't be a file name here`);
  }

  // write a file into dir (null: the root), replacing one of that name. progress(done, total)
  async writeFile(dir, name, data, progress = () => {}) {
    this.checkName(name);
    this.forget();
    await this.loadFat();
    const area = await this.dirArea(dir);
    const old = this.find(area, name);
    if (old && old.isDir) throw new Error(`"${name}" is a folder`);
    const need = Math.ceil(data.length / this.clusterBytes);
    if (old) this.freeChainOf(await this.chain(old.cluster));
    const cl = need ? this.alloc(need) : [];
    let done = 0;
    for (const [lba, n, at] of this.runs(cl)) {
      const per = this.clusterBytes, bytes = new Uint8Array(n * 512);
      bytes.set(data.subarray(at * per, Math.min(data.length, at * per + n * 512)));
      await this.disk.write(lba, bytes);
      done += n * 512;
      progress(Math.min(done, data.length), data.length);
    }
    await this.flushFat();
    if (old) {
      const e = area.buf.subarray(old.slot * 32, old.slot * 32 + 32), now = new Date();
      put16(e, 26, cl[0] || 0); put32(e, 28, data.length);
      put16(e, 22, dosTime(now)); put16(e, 24, dosDate(now)); put16(e, 18, dosDate(now));
      await this.writeDirSectors(area, old.slot, old.slot + 1);
    } else await this.addEntry(area, name, 0x20, cl[0] || 0, data.length);
  }

  async mkdir(dir, name) {
    this.checkName(name);
    this.forget();
    await this.loadFat();
    const area = await this.dirArea(dir);
    if (this.find(area, name)) throw new Error(`"${name}" is already there`);
    const [c] = this.alloc(1);
    const blk = new Uint8Array(this.clusterBytes);
    blk.set(this.makeEntries('.', '.', false, 0x10, c, 0)[0], 0);
    blk.set(this.makeEntries('..', '..', false, 0x10, dir ? dir.cluster : 0, 0)[0], 32);
    blk[0] = 0x2e; blk[32] = 0x2e; blk[33] = 0x2e;   // "." and "..", space-padded
    await this.writeClusters([c], blk);
    await this.addEntry(area, name, 0x10, c, 0);
  }

  // delete a file, or an empty folder
  async remove(dir, entry) {
    this.forget();
    await this.loadFat();
    const area = await this.dirArea(dir);
    const e = this.find(area, entry.name);
    if (!e) throw new Error(`"${entry.name}" isn't there any more`);
    if (e.isDir && (await this.list(e)).length) throw new Error(`"${e.name}" isn't empty`);
    for (let i = e.first; i <= e.slot; i++) area.buf[i * 32] = 0xe5;
    if (e.cluster) this.freeChainOf(await this.chain(e.cluster));
    await this.writeDirSectors(area, e.first, e.slot + 1);
    await this.flushFat();
  }
}
