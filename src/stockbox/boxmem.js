// The box's memory, from the bridge: READ / WRITE / CALL requests to the loader (protocol.js),
// one at a time, with callbacks. Long reads and writes go out in chunks; ranges are checked
// here too, so a mistake costs no round trip. The shell (shell.js) and any other tool sit on
// top of this; on the Pico it sits on the PARMOD link the same way.
//
//   const mem = new BoxMem(session);
//   mem.read(addr, width, count, (err, values) => ...)    values: numbers, one an item
//   mem.write(addr, width, values, (err) => ...)
//   mem.call(addr, [a0, a1, a2, a3], (err, v0) => ...)

import { enc, FAULT, RANGES } from './protocol.js';

const CHUNK = 1024; // bytes a request

export function checkRange(addr, width, count) {
  if (![1, 2, 4].includes(width)) return FAULT[3];
  if (addr % width) return FAULT[2];
  const end = addr + width * count;
  return RANGES.some(([a, b]) => addr >= a && end <= b) ? null : FAULT[1];
}

export class BoxMem {
  constructor(session) {
    this.s = session;
    this.queue = [];
    this.busy = null;
    session.onMessage = (msg) => this.reply(msg);
  }

  get idle() { return !this.busy && !this.queue.length; }

  // one request on the link at a time: { bytes, width (for DATA), done(msg) }
  request(req) { this.queue.push(req); this.next(); }

  next() {
    if (this.busy || !this.queue.length) return;
    this.busy = this.queue.shift();
    this.s.parser.width = this.busy.width;
    this.s.send(this.busy.bytes);
  }

  reply(msg) {
    if (!this.busy || !['data', 'done', 'ret', 'fault'].includes(msg.type)) return false;
    const req = this.busy;
    this.busy = null;
    req.done(msg);
    this.next();
    return true;
  }

  read(addr, width, count, cb) {
    const bad = checkRange(addr >>> 0, width, count);
    if (bad) { cb(bad); return; }
    const values = [], per = CHUNK / width;
    let at = addr >>> 0, left = count;
    const more = () => {
      if (!left) { cb(null, values); return; }
      const n = Math.min(left, per);
      this.request({ bytes: enc.read(at, width, n), width, done: (msg) => {
        if (msg.type !== 'data') { cb(FAULT[msg.why] ?? msg.type); return; }
        for (let i = 0; i < msg.bytes.length; i += width) {
          let v = 0;
          for (let k = 0; k < width; k++) v = (v << 8) | msg.bytes[i + k];
          values.push(v >>> 0);
        }
        at += n * width; left -= n;
        more();
      } });
    };
    more();
  }

  write(addr, width, values, cb) {
    const bad = checkRange(addr >>> 0, width, values.length);
    if (bad) { cb(bad); return; }
    const per = CHUNK / width;
    let i = 0;
    const more = () => {
      if (i >= values.length) { cb(null); return; }
      const part = values.slice(i, i + per);
      this.request({ bytes: enc.write((addr >>> 0) + i * width, width, part), done: (msg) => {
        if (msg.type !== 'done') { cb(FAULT[msg.why] ?? msg.type); return; }
        i += part.length;
        more();
      } });
    };
    more();
  }

  call(addr, args, cb) {
    const bad = checkRange(addr >>> 0, 4, 1);
    if (bad) { cb(bad); return; }
    this.request({ bytes: enc.call(addr >>> 0, args), done: (msg) => cb(msg.type === 'ret' ? null : FAULT[msg.why] ?? msg.type, msg.v0) });
  }
}
