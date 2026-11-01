// Generic register-file stand-in for SOLO units that are not emulated yet: stores writes,
// returns them on reads, and logs the first access to each register.

export class RegStub {
  constructor(name, machine) {
    this.name = name;
    this.m = machine;
    this.regs = new Map();
    this.seen = new Set();
  }
  note(off, what, v) {
    const k = what + off;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.m.log(`[${this.name}] ${what} 0400${off.toString(16).padStart(4, '0')}${v !== undefined ? ' = ' + (v >>> 0).toString(16) : ''}`);
  }
  read(off) { this.note(off, 'read'); return this.regs.get(off) | 0; }
  write(off, v) { this.note(off, 'write', v); this.regs.set(off, v); }
}
