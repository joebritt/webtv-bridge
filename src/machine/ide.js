// ATA (IDE) disk on the SOLO RIO bus. Registers are at a 4-byte stride:
//   cs0: base + 0x00 .. 0x1c   (data, error/feature, count, sector, cyl lo, cyl hi, drive/head, status/command)
//   cs1: base + 0x400018       (alt status / device control), base + 0x40001c (drive address)
//
// The disk backend provides getSectors(lba, count) -> Uint8Array | Promise<Uint8Array> and
// putSectors(lba, data). Data words follow the usual ATA convention (word = b0 | b1 << 8);
// on the WebTV the data bus is byte-swapped, which is why raw PC dumps of WebTV drives look
// byte-swapped. Use the raw (unflipped) dump with this device.
//
// ATA security: a real WebTV drive is password-locked at power-on and the boot ROM unlocks it.
// The emulated drive starts unlocked, unless `lock({ password })` is called (password: the 32
// bytes the box must send, or null to accept any); while locked, IDENTIFY says so and media
// commands abort. Every SECURITY UNLOCK's data block is kept in `unlockAttempts`.

const ST_ERR = 0x01, ST_DRQ = 0x08, ST_DSC = 0x10, ST_DRDY = 0x40, ST_BSY = 0x80;
const ER_ABRT = 0x04, ER_IDNF = 0x10;

export class IdeDisk {
  constructor(machine, backend, { onIrq } = {}) {
    this.m = machine;
    this.backend = backend;
    this.onIrq = onIrq || (() => {});
    this.log = machine.log;
    this.totalSectors = backend ? Math.floor(backend.size / 512) : 0;
    // CHS geometry (16 heads, 63 sectors)
    this.heads = 16; this.spt = 63;
    this.cyls = Math.min(16383, Math.floor(this.totalSectors / (this.heads * this.spt)));
    this.unknownLogged = new Set();
    this.locked = false; this.password = null; this.unlockAttempts = [];
    this.reset();
  }

  reset() {
    this.error = 1; // diagnostic code
    this.feature = 0;
    this.count = 1; this.sector = 1; this.cylLo = 0; this.cylHi = 0; this.drvHead = 0;
    this.status = this.backend ? (ST_DRDY | ST_DSC) : 0;
    this.devCtl = 0;
    this.buf = null; this.bufPos = 0;
    this.xferRemain = 0; // sectors left in the current command
    this.cmd = 0;
    this.multiple = 1;
    this.irq = false;
    this.hob = new Uint8Array(6);
    this.lba48 = false;
  }

  get present() { return !!this.backend && (this.drvHead & 0x10) === 0; }

  setIrq(state) {
    this.irq = state;
    this.onIrq(state && !(this.devCtl & 2));
  }

  read(pa, size) {
    const off = pa - 0x1e400000;
    if (off === 0x400018) return this.present ? this.status : 0;
    if (off === 0x40001c) return 0xff;
    switch (off >> 2) {
      case 0: return this.readData();
      case 1: return this.present ? this.error : 0;
      case 2: return this.present ? this.count : 0;
      case 3: return this.present ? this.sector : 0;
      case 4: return this.present ? this.cylLo : 0;
      case 5: return this.present ? this.cylHi : 0;
      case 6: return this.drvHead | 0xa0;
      case 7:
        if (!this.present) return 0;
        this.setIrq(false);
        return this.status;
    }
    this.unk(off, 'read');
    return 0;
  }

  write(pa, v, size) {
    const off = pa - 0x1e400000;
    if (off === 0x400018) {
      if ((v & 4) && !(this.devCtl & 4)) { // SRST
        this.reset();
      }
      this.devCtl = v & 0xff;
      return;
    }
    if (off === 0x40001c) return;
    const b = v & 0xff;
    switch (off >> 2) {
      case 0: this.writeData(v & 0xffff); return;
      case 1: this.hob[0] = this.feature; this.feature = b; return;
      case 2: this.hob[1] = this.count; this.count = b; return;
      case 3: this.hob[2] = this.sector; this.sector = b; return;
      case 4: this.hob[3] = this.cylLo; this.cylLo = b; return;
      case 5: this.hob[4] = this.cylHi; this.cylHi = b; return;
      case 6: this.drvHead = b; return;
      case 7: if (this.present) this.command(b); return;
    }
    this.unk(off, 'write');
  }

  unk(off, what) {
    const k = what + off;
    if (!this.unknownLogged.has(k)) { this.unknownLogged.add(k); this.log(`[ide] unhandled ${what} +${off.toString(16)}`); }
  }

  // ------------------------------------------------------------------ addressing

  getLba() {
    if (this.drvHead & 0x40) {
      return ((this.drvHead & 0x0f) << 24) | (this.cylHi << 16) | (this.cylLo << 8) | this.sector;
    }
    const cyl = (this.cylHi << 8) | this.cylLo;
    const head = this.drvHead & 0x0f;
    return (cyl * this.heads + head) * this.spt + (this.sector - 1);
  }

  setLba(lba) {
    if (this.drvHead & 0x40) {
      this.sector = lba & 0xff; this.cylLo = (lba >> 8) & 0xff; this.cylHi = (lba >> 16) & 0xff;
      this.drvHead = (this.drvHead & 0xf0) | ((lba >> 24) & 0x0f);
    } else {
      const s = (lba % this.spt) + 1;
      const t = Math.floor(lba / this.spt);
      const h = t % this.heads, c = Math.floor(t / this.heads);
      this.sector = s; this.cylLo = c & 0xff; this.cylHi = (c >> 8) & 0xff;
      this.drvHead = (this.drvHead & 0xf0) | h;
    }
  }

  // ------------------------------------------------------------------ commands

  abort() {
    this.error = ER_ABRT;
    this.status = ST_DRDY | ST_DSC | ST_ERR;
    this.setIrq(true);
  }

  done() {
    this.error = 0;
    this.status = ST_DRDY | ST_DSC;
    this.setIrq(true);
  }

  // until power-off (lock() again to re-lock)
  lock({ password = null } = {}) { this.locked = true; this.password = password; }

  command(c) {
    this.cmd = c;
    this.setIrq(false);
    if (this.locked && [0x20, 0x21, 0xc4, 0x30, 0x31, 0xc5, 0x40, 0x41].includes(c)) { this.abort(); return; }
    switch (c) {
      case 0x20: case 0x21: case 0xc4: // READ SECTORS / READ MULTIPLE
        this.xferRemain = this.count || 256;
        this.startRead();
        return;
      case 0x30: case 0x31: case 0xc5: // WRITE SECTORS / WRITE MULTIPLE
        this.xferRemain = this.count || 256;
        this.wbuf = new Uint8Array(512 * this.blockSize());
        this.bufPos = 0;
        this.error = 0;
        this.status = ST_DRDY | ST_DSC | ST_DRQ;
        return;
      case 0x40: case 0x41: { // READ VERIFY
        const lba = this.getLba() + ((this.count || 256) - 1);
        if (lba >= this.totalSectors) { this.error = ER_IDNF; this.status = ST_DRDY | ST_ERR; this.setIrq(true); return; }
        this.setLba(lba);
        this.done();
        return;
      }
      case 0xec: this.identify(); return;
      case 0xc6: // SET MULTIPLE MODE
        if (this.count === 0 || this.count > 16 || (this.count & (this.count - 1))) { this.abort(); return; }
        this.multiple = this.count; this.done(); return;
      case 0x91: // INITIALIZE DEVICE PARAMETERS
        this.done(); return;
      case 0x90: // EXECUTE DEVICE DIAGNOSTIC
        this.error = 1; this.status = ST_DRDY | ST_DSC; this.count = 1; this.sector = 1; this.cylLo = 0; this.cylHi = 0;
        this.setIrq(true); return;
      case 0xf8: // READ NATIVE MAX ADDRESS
        this.setLba(this.totalSectors - 1); this.done(); return;
      case 0xe5: case 0x98: // CHECK POWER MODE
        this.count = 0xff; this.done(); return;
      default:
        if ((c & 0xf0) === 0x10 || (c & 0xf0) === 0x70) { this.done(); return; } // RECALIBRATE / SEEK
        // IDLE/STANDBY/SLEEP, FLUSH CACHE, SET FEATURES, security (drive image is already unlocked),
        // door lock etc: accept.
        if ([0xe0, 0xe1, 0xe2, 0xe3, 0xe6, 0x94, 0x95, 0x96, 0x97, 0x99, 0xe7, 0xea, 0xef, 0xde, 0xdf,
          0xf3, 0xf5, 0xf6].includes(c)) { this.done(); return; }
        if (c === 0xf1 || c === 0xf2 || c === 0xf4) { // SECURITY SET/UNLOCK/ERASE UNIT take a data block
          this.secCmd = c; this.wbuf = new Uint8Array(512); this.bufPos = 0; this.xferRemain = 1;
          this.status = ST_DRDY | ST_DSC | ST_DRQ; return;
        }
        this.log(`[ide] unsupported command ${c.toString(16)}`);
        this.abort();
    }
  }

  blockSize() {
    return (this.cmd === 0xc4 || this.cmd === 0xc5) ? Math.min(this.multiple, this.xferRemain) : 1;
  }

  startRead() {
    const lba = this.getLba();
    const n = this.blockSize();
    if (lba + n > this.totalSectors) { this.error = ER_IDNF; this.status = ST_DRDY | ST_ERR; this.setIrq(true); return; }
    this.status = ST_BSY | ST_DSC;
    const res = this.backend.getSectors(lba, n);
    const finish = (data) => {
      this.buf = data; this.bufPos = 0;
      this.setLba(lba + n - 1);
      this.pendingAdvance = true;
      this.xferRemain -= n;
      this.error = 0;
      this.status = ST_DRDY | ST_DSC | ST_DRQ;
      this.setIrq(true);
    };
    if (res && typeof res.then === 'function') res.then(finish);
    else {
      // keep the drive busy briefly so software sees a realistic BSY->DRQ transition
      this.m.sched.after('ide-read', 2000, () => finish(res));
    }
  }

  readData() {
    if (!this.buf || !(this.status & ST_DRQ)) return 0xffff;
    const p = this.bufPos;
    const w = this.buf[p] | (this.buf[p + 1] << 8);
    this.bufPos += 2;
    if (this.bufPos >= this.buf.length) {
      this.buf = null;
      if (this.cmd === 0xec) { this.status = ST_DRDY | ST_DSC; return w; }
      if (this.xferRemain > 0) {
        this.setLba(this.getLba() + 1);
        this.startRead();
      } else {
        this.status = ST_DRDY | ST_DSC;
      }
    }
    return w;
  }

  writeData(w) {
    if (!this.wbuf || !(this.status & ST_DRQ)) return;
    this.wbuf[this.bufPos] = w & 0xff;
    this.wbuf[this.bufPos + 1] = (w >> 8) & 0xff;
    this.bufPos += 2;
    if (this.bufPos < this.wbuf.length) return;
    if (this.secCmd) {
      const c = this.secCmd, data = this.wbuf;
      this.secCmd = 0; this.wbuf = null;
      if (c === 0xf2) { // SECURITY UNLOCK: word 0 = control, words 1-16 = password
        const pw = data.slice(2, 34);
        this.unlockAttempts.push(pw);
        if (this.locked && this.password && !this.password.every((b, i) => b === pw[i])) { this.abort(); return; }
        this.locked = false;
      }
      this.done(); return;
    }
    const lba = this.getLba();
    const n = this.wbuf.length / 512;
    this.backend.putSectors(lba, this.wbuf);
    this.xferRemain -= n;
    this.status = ST_BSY | ST_DSC;
    this.m.sched.after('ide-write', 2000, () => {
      if (this.xferRemain > 0) {
        this.setLba(lba + n);
        this.wbuf = new Uint8Array(512 * this.blockSize());
        this.bufPos = 0;
        this.status = ST_DRDY | ST_DSC | ST_DRQ;
      } else {
        this.setLba(lba + n - 1);
        this.wbuf = null;
        this.status = ST_DRDY | ST_DSC;
      }
      this.setIrq(true);
    });
  }

  identify() {
    const id = new Uint16Array(256);
    const str = (wordOff, len, s) => {
      s = s.padEnd(len * 2, ' ');
      for (let i = 0; i < len; i++) id[wordOff + i] = (s.charCodeAt(2 * i) << 8) | s.charCodeAt(2 * i + 1);
    };
    const total = Math.min(this.totalSectors, 0x0fffffff);
    id[0] = 0x0040;
    id[1] = this.cyls; id[3] = this.heads; id[6] = this.spt;
    str(10, 10, 'WTVEMU0001');
    str(23, 4, '1.0');
    str(27, 20, 'WebTV Emulated Disk');
    id[47] = 0x8010; // max 16 sectors per READ/WRITE MULTIPLE
    id[49] = 0x0200; // LBA supported
    id[51] = 0x0200; id[53] = 0x0001;
    id[54] = this.cyls; id[55] = this.heads; id[56] = this.spt;
    const chs = this.cyls * this.heads * this.spt;
    id[57] = chs & 0xffff; id[58] = chs >>> 16;
    id[59] = 0x0100 | this.multiple;
    id[60] = total & 0xffff; id[61] = total >>> 16;
    id[80] = 0x001e; // ATA-1..4
    id[82] = 0x0002; // security feature set supported
    id[128] = this.locked ? 0x0007 : 0x0001; // security supported (+ enabled, locked)
    const buf = new Uint8Array(512);
    for (let i = 0; i < 256; i++) { buf[2 * i] = id[i] & 0xff; buf[2 * i + 1] = id[i] >> 8; }
    this.buf = buf; this.bufPos = 0;
    this.error = 0;
    this.status = ST_DRDY | ST_DSC | ST_DRQ;
    this.setIrq(true);
  }
}

// Disk backends ---------------------------------------------------------------

/** In-memory overlay of written sectors on top of a read-only source. */
export class OverlayDisk {
  constructor(size, readFn) {
    this.size = size;
    this.readFn = readFn; // (lba, count) => Uint8Array | Promise<Uint8Array>
    this.dirty = new Map(); // lba -> Uint8Array(512)
    this.onWrite = null;    // optional (lba) => void, e.g. to persist written sectors
  }
  applyOverlay(lba, data) {
    for (let i = 0; i < data.length / 512; i++) {
      const d = this.dirty.get(lba + i);
      if (d) data.set(d, i * 512);
    }
    return data;
  }
  getSectors(lba, count) {
    const r = this.readFn(lba, count);
    if (r && typeof r.then === 'function') return r.then((d) => this.applyOverlay(lba, d));
    return this.applyOverlay(lba, r);
  }
  putSectors(lba, data) {
    for (let i = 0; i < data.length / 512; i++) {
      this.dirty.set(lba + i, data.slice(i * 512, i * 512 + 512));
      if (this.onWrite) this.onWrite(lba + i);
    }
  }
}
