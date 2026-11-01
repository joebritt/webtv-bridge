// Tiny event scheduler keyed by CPU cycle count. Events are identified by name so they can
// be rescheduled/cancelled; there are only ever a handful outstanding.

export class Scheduler {
  constructor(cpu) {
    this.cpu = cpu;
    this.events = []; // {name, time, fn}, kept sorted by time
  }

  at(name, time, fn) {
    this.cancel(name);
    const ev = { name, time, fn };
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].time > time) i--;
    this.events.splice(i, 0, ev);
    // the new first event may come before the end of the slice the CPU is running (an event
    // scheduled from an I/O access): end the slice so it runs on time
    if (i === 0) this.cpu.stopRequested = true;
  }

  after(name, cycles, fn) { this.at(name, this.cpu.cycles + cycles, fn); }

  cancel(name) {
    const i = this.events.findIndex((e) => e.name === name);
    if (i >= 0) this.events.splice(i, 1);
  }

  pending(name) { return this.events.some((e) => e.name === name); }

  nextTime() { return this.events.length ? this.events[0].time : Infinity; }

  runDue() {
    const now = this.cpu.cycles;
    while (this.events.length && this.events[0].time <= now) {
      const ev = this.events.shift();
      ev.fn();
    }
  }
}
