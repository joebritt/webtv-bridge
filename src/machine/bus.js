// Physical address space of the LC2 / SOLO1 WebTV box.
//
//   0x00000000-0x03ffffff  SDRAM (8MB installed, mirrored)
//   0x04000000-0x0400ffff  SOLO1 control registers
//   0x1e000000-0x1e00001f  hardware modem (16550-style UART at 4-byte stride)
//   0x1e400000-0x1e80001f  IDE (cs0 at +0, cs1 at +0x400000)
//   0x1f000000-0x1f3fffff  ROML (bank 0) - unpopulated on the LC2 Plus
//   0x1f800000-0x1fffffff  ROMU (bank 1) - 2MB boot ROM, mirrored
//
// Devices implement read(pa, size) / write(pa, value, size), where size is 1, 2 or 4 and
// values are right-aligned (big-endian lane already handled by the device or by this bus).

export class Bus {
  constructor({ ramSize = 8 << 20, rom }) {
    this.ramBytes = ramSize;
    this.ram = new Int32Array(ramSize >>> 2);
    this.ramMask = ramSize - 1;
    this.romBase = 0x1f800000;
    this.rom = rom; // Int32Array of big-endian words already converted to native ints
    this.romMask = (rom.length * 4) - 1;
    this.regions = []; // {start, end, dev}
    this.unmappedLogged = new Set();
    this.log = (...a) => console.log(...a);
    this.watch = null; // optional (pa, size, isWrite, value) => void for MMIO tracing
  }

  map(start, end, dev) {
    this.regions.push({ start, end, dev });
  }

  findRegion(pa) {
    const r = this.regions;
    for (let i = 0; i < r.length; i++) {
      if (pa >= r[i].start && pa <= r[i].end) return r[i];
    }
    return null;
  }

  unmapped(pa, size, isWrite, v) {
    const key = (pa >>> 8) + (isWrite ? 'w' : 'r');
    if (!this.unmappedLogged.has(key)) {
      this.unmappedLogged.add(key);
      this.log(`[bus] unmapped ${isWrite ? 'write' : 'read'}${size * 8} ${(pa >>> 0).toString(16)}${isWrite ? ' = ' + (v >>> 0).toString(16) : ''}`);
    }
    return 0;
  }

  // ---------------------------------------------------------------- reads

  read32(pa) {
    if (pa < 0x04000000) return this.ram[(pa & this.ramMask) >>> 2];
    if (pa >= this.romBase) return this.rom[((pa - this.romBase) & this.romMask) >>> 2];
    const r = this.findRegion(pa);
    if (r) {
      const v = r.dev.read(pa, 4) | 0;
      if (this.watch) this.watch(pa, 4, false, v);
      return v;
    }
    return this.unmapped(pa, 4, false);
  }

  read16(pa) {
    if (pa < 0x04000000) {
      const w = this.ram[(pa & this.ramMask) >>> 2];
      return (pa & 2) ? (w & 0xffff) : (w >>> 16);
    }
    if (pa >= this.romBase) {
      const w = this.rom[((pa - this.romBase) & this.romMask) >>> 2];
      return (pa & 2) ? (w & 0xffff) : (w >>> 16);
    }
    const r = this.findRegion(pa);
    if (r) {
      const v = r.dev.read(pa, 2) & 0xffff;
      if (this.watch) this.watch(pa, 2, false, v);
      return v;
    }
    return this.unmapped(pa, 2, false);
  }

  read8(pa) {
    if (pa < 0x04000000) {
      return (this.ram[(pa & this.ramMask) >>> 2] >>> ((3 - (pa & 3)) << 3)) & 0xff;
    }
    if (pa >= this.romBase) {
      return (this.rom[((pa - this.romBase) & this.romMask) >>> 2] >>> ((3 - (pa & 3)) << 3)) & 0xff;
    }
    const r = this.findRegion(pa);
    if (r) {
      const v = r.dev.read(pa, 1) & 0xff;
      if (this.watch) this.watch(pa, 1, false, v);
      return v;
    }
    return this.unmapped(pa, 1, false);
  }

  // ---------------------------------------------------------------- writes

  write32(pa, v) {
    if (pa < 0x04000000) {
      this.ram[(pa & this.ramMask) >>> 2] = v;
      if (this.jit && this.jit.codePages[pa >>> 12]) this.jit.invalidatePage(pa >>> 12);
      return;
    }
    if (pa >= this.romBase) return;
    const r = this.findRegion(pa);
    if (r) {
      if (this.watch) this.watch(pa, 4, true, v);
      r.dev.write(pa, v | 0, 4);
      return;
    }
    this.unmapped(pa, 4, true, v);
  }

  write16(pa, v) {
    if (pa < 0x04000000) {
      const i = (pa & this.ramMask) >>> 2;
      const w = this.ram[i];
      this.ram[i] = (pa & 2) ? ((w & 0xffff0000) | (v & 0xffff)) : ((w & 0xffff) | (v << 16));
      if (this.jit && this.jit.codePages[pa >>> 12]) this.jit.invalidatePage(pa >>> 12);
      return;
    }
    if (pa >= this.romBase) return;
    const r = this.findRegion(pa);
    if (r) {
      if (this.watch) this.watch(pa, 2, true, v);
      r.dev.write(pa, v & 0xffff, 2);
      return;
    }
    this.unmapped(pa, 2, true, v);
  }

  write8(pa, v) {
    if (pa < 0x04000000) {
      const i = (pa & this.ramMask) >>> 2;
      const sh = (3 - (pa & 3)) << 3;
      this.ram[i] = (this.ram[i] & ~(0xff << sh)) | ((v & 0xff) << sh);
      if (this.jit && this.jit.codePages[pa >>> 12]) this.jit.invalidatePage(pa >>> 12);
      return;
    }
    if (pa >= this.romBase) return;
    const r = this.findRegion(pa);
    if (r) {
      if (this.watch) this.watch(pa, 1, true, v);
      r.dev.write(pa, v & 0xff, 1);
      return;
    }
    this.unmapped(pa, 1, true, v);
  }

  // ---------------------------------------------------------------- DMA helpers (physical)

  dmaRead32(pa) { return this.ram[(pa & this.ramMask) >>> 2]; }
  dmaWrite32(pa, v) {
    this.ram[(pa & this.ramMask) >>> 2] = v;
    if (this.jit && this.jit.codePages[(pa & 0x1fffffff) >>> 12]) this.jit.invalidatePage((pa & 0x1fffffff) >>> 12);
  }
  dmaRead16(pa) { return this.read16(pa & 0x1fffffff); }
  dmaWrite16(pa, v) { this.write16(pa & 0x1fffffff, v); }
  dmaRead8(pa) { return this.read8(pa & 0x1fffffff); }
}
