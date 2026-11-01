// Bit-banged I2C bus with a 24C01-style EEPROM (the WebTV NVRAM at 0xa0) and simple
// register-file slaves for the other parts on the LC2 IIC bus (tuner, Bt827, SAA7187, ...).

export class I2cRegDevice {
  constructor(name, size = 256) {
    this.name = name;
    this.mem = new Uint8Array(size);
    this.ptr = 0;
    this.gotPtr = false;
  }
  start() { this.gotPtr = false; }
  writeByte(b) {
    if (!this.gotPtr) { this.ptr = b % this.mem.length; this.gotPtr = true; }
    else { this.mem[this.ptr] = b; this.ptr = (this.ptr + 1) % this.mem.length; }
    return true;
  }
  readByte() { const v = this.mem[this.ptr]; this.ptr = (this.ptr + 1) % this.mem.length; return v; }
}

// AT24C01A: 128 bytes, 8-byte page writes.
export class Eeprom24c01 extends I2cRegDevice {
  constructor(data) {
    super('nvram', 128);
    if (data) this.mem.set(data.subarray(0, 128));
    this.onChange = null;
  }
  writeByte(b) {
    if (!this.gotPtr) { this.ptr = b & 0x7f; this.gotPtr = true; }
    else {
      this.mem[this.ptr] = b;
      this.ptr = (this.ptr & ~7) | ((this.ptr + 1) & 7);
      if (this.onChange) this.onChange(this.mem);
    }
    return true;
  }
}

export class I2cBus {
  constructor() {
    this.devices = new Map(); // 7-bit address -> device
    this.scl = 1; this.sdaMaster = 1; this.sdaSlave = 1;
    this.state = 'idle';
    this.bits = 0; this.nbits = 0;
    this.dev = null; this.reading = false;
    this.outByte = 0;
    this.log = null;
  }
  attach(addr8, dev) { this.devices.set(addr8 >> 1, dev); }

  get sda() { return this.sdaMaster & this.sdaSlave; }

  // Called whenever the master changes SCL or SDA.
  set(scl, sda) {
    const oldScl = this.scl, oldSda = this.sdaMaster;
    this.scl = scl; this.sdaMaster = sda;
    if (oldScl && scl && oldSda !== sda) {
      if (!sda) { // START (or repeated start)
        this.state = 'addr'; this.bits = 0; this.nbits = 0; this.sdaSlave = 1;
        if (this.dev) this.dev.start();
        return;
      }
      // STOP
      this.state = 'idle'; this.sdaSlave = 1; this.dev = null;
      return;
    }
    if (!oldScl && scl) this.rise();
    else if (oldScl && !scl) this.fall();
  }

  rise() {
    switch (this.state) {
      case 'addr': case 'write':
        this.bits = (this.bits << 1) | this.sdaMaster; this.nbits++;
        break;
      case 'read':
        break;
      case 'mack': // master ack bit after a read byte
        this.masterNack = this.sdaMaster;
        break;
    }
  }

  fall() {
    switch (this.state) {
      case 'addr':
        if (this.nbits === 8) {
          const a = this.bits;
          this.dev = this.devices.get(a >> 1) || null;
          this.reading = (a & 1) === 1;
          if (this.dev) { this.dev.start && !this.reading ? null : null; this.sdaSlave = 0; this.state = 'sack'; this.next = this.reading ? 'read' : 'write'; }
          else { this.sdaSlave = 1; this.state = 'nack'; if (this.log) this.log(`[i2c] no device at ${a.toString(16)}`); }
        }
        break;
      case 'write':
        if (this.nbits === 8) {
          const ok = this.dev.writeByte(this.bits & 0xff);
          this.sdaSlave = ok ? 0 : 1; this.state = 'sack'; this.next = 'write';
        }
        break;
      case 'sack': // slave ack bit has been clocked; move on
        this.sdaSlave = 1;
        this.bits = 0; this.nbits = 0;
        if (this.next === 'read') this.loadRead();
        else this.state = this.next;
        break;
      case 'read':
        this.nbits++;
        if (this.nbits === 8) { this.sdaSlave = 1; this.state = 'mack'; }
        else this.sdaSlave = (this.outByte >> (7 - this.nbits)) & 1;
        break;
      case 'mack':
        if (this.masterNack) { this.state = 'idle'; this.sdaSlave = 1; }
        else this.loadRead();
        break;
      case 'nack':
        this.state = 'idle';
        break;
    }
  }

  loadRead() {
    this.outByte = this.dev.readByte();
    this.nbits = 0;
    this.state = 'read';
    this.sdaSlave = (this.outByte >> 7) & 1;
  }
}

// Dallas DS2401 silicon serial number: family 0x01, 48-bit serial, CRC8.
export function makeSerialId(serial48) {
  const b = new Uint8Array(8);
  b[0] = 0x01;
  for (let i = 0; i < 6; i++) b[1 + i] = (serial48 / Math.pow(256, i)) & 0xff;
  let crc = 0;
  for (let i = 0; i < 7; i++) {
    let x = b[i];
    for (let j = 0; j < 8; j++) {
      const mix = (crc ^ x) & 1;
      crc >>= 1;
      if (mix) crc ^= 0x8c;
      x >>= 1;
    }
  }
  b[7] = crc;
  return b;
}
