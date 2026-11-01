// IPv4 gateway for the PPP link: answers ICMP echo and DNS (UDP/53) itself and terminates
// every TCP connection the box opens, splicing its byte stream onto a `transport` stream
// (normally a WebSocket to tools/relay.mjs).
//
// transport: { openTcp(host, port, handlers) -> conn, resolve(name) -> Promise<ip string|null> }
//   handlers: { onOpen(), onData(Uint8Array), onEnd(), onClose(err) }
//   conn: { send(Uint8Array), end(), close() }

const PROTO_ICMP = 1, PROTO_TCP = 6, PROTO_UDP = 17;
const FIN = 1, SYN = 2, RST = 4, PSH = 8, ACK = 16;

export const ipStr = (a, o = 0) => `${a[o]}.${a[o + 1]}.${a[o + 2]}.${a[o + 3]}`;
const ipBytes = (s) => s.split('.').map(Number);

export function checksum(buf, start = 0, end = buf.length, init = 0) {
  let s = init;
  for (let i = start; i + 1 < end; i += 2) s += (buf[i] << 8) | buf[i + 1];
  if ((end - start) & 1) s += buf[end - 1] << 8;
  while (s > 0xffff) s = (s & 0xffff) + (s >>> 16);
  return s;
}
const r16 = (b, o) => (b[o] << 8) | b[o + 1];
const r32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const w16 = (b, o, v) => { b[o] = (v >>> 8) & 255; b[o + 1] = v & 255; };
const w32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
const seqLt = (a, b) => ((a - b) | 0) < 0;
const seqLe = (a, b) => ((a - b) | 0) <= 0;

function pseudoSum(src, dst, proto, len) {
  return checksum(Uint8Array.from([...src, ...dst, 0, proto, len >>> 8, len & 255]));
}

export class IpGateway {
  // o: { send(pkt), transport, log, gateway: [10,0,0,1], hostMap: {name: ip} }
  constructor(o) {
    this.o = o;
    this.log = o.log || (() => {});
    this.gw = o.gateway || [10, 0, 0, 1];
    this.hostMap = {};
    for (const [k, v] of Object.entries(o.hostMap || {})) this.hostMap[k.toLowerCase()] = v;
    this.ipId = 1;
    this.tcp = new Map();
    this.connLog = [];
  }

  // ------------------------------------------------------------ IPv4

  input(p) {
    if (p.length < 20 || (p[0] >> 4) !== 4) return;
    const ihl = (p[0] & 15) * 4, total = r16(p, 2);
    if (total > p.length || total < ihl || checksum(p, 0, ihl) !== 0xffff) { this.log('[ip] bad header'); return; }
    if ((r16(p, 6) & 0x3fff) !== 0) { this.log('[ip] fragment dropped'); return; }
    const src = p.subarray(12, 16), dst = p.subarray(16, 20), proto = p[9];
    const data = p.subarray(ihl, total);
    switch (proto) {
      case PROTO_ICMP: this.icmp(src, dst, data); return;
      case PROTO_UDP: this.udp(src, dst, data); return;
      case PROTO_TCP: this.tcpInput(src, dst, data); return;
    }
    this.log(`[ip] ${ipStr(src)} -> ${ipStr(dst)} proto ${proto} ignored`);
  }

  output(src, dst, proto, payload) {
    const p = new Uint8Array(20 + payload.length);
    p[0] = 0x45; w16(p, 2, p.length); w16(p, 4, this.ipId++ & 0xffff); p[6] = 0x40; // DF
    p[8] = 64; p[9] = proto;
    p.set(src, 12); p.set(dst, 16);
    w16(p, 10, ~checksum(p, 0, 20) & 0xffff);
    p.set(payload, 20);
    this.o.send(p);
  }

  // ------------------------------------------------------------ ICMP

  icmp(src, dst, d) {
    if (d.length < 8 || checksum(d) !== 0xffff) return;
    if (d[0] !== 8) { this.log(`[icmp] type ${d[0]} from box ignored`); return; }
    const r = Uint8Array.from(d);
    r[0] = 0; r[2] = r[3] = 0;
    w16(r, 2, ~checksum(r) & 0xffff);
    this.output(dst, src, PROTO_ICMP, r);
  }

  // ------------------------------------------------------------ UDP / DNS

  udp(src, dst, d) {
    if (d.length < 8) return;
    const sport = r16(d, 0), dport = r16(d, 2);
    const payload = d.subarray(8, r16(d, 4));
    if (dport === 53) { this.dns(src, dst, sport, payload); return; }
    this.log(`[udp] ${ipStr(src)}:${sport} -> ${ipStr(dst)}:${dport} (${payload.length} bytes) dropped`);
  }

  udpOutput(src, dst, sport, dport, payload) {
    const u = new Uint8Array(8 + payload.length);
    w16(u, 0, sport); w16(u, 2, dport); w16(u, 4, u.length);
    u.set(payload, 8);
    const c = ~checksum(u, 0, u.length, pseudoSum(src, dst, PROTO_UDP, u.length)) & 0xffff;
    w16(u, 6, c || 0xffff);
    this.output(src, dst, PROTO_UDP, u);
  }

  async dns(src, dst, sport, q) {
    if (q.length < 12) return;
    src = Uint8Array.from(src); dst = Uint8Array.from(dst); q = Uint8Array.from(q);
    const qd = r16(q, 4);
    // parse the first question
    let i = 12; const labels = [];
    while (i < q.length && q[i]) { labels.push(String.fromCharCode(...q.subarray(i + 1, i + 1 + q[i]))); i += q[i] + 1; }
    const name = labels.join('.'), qtype = r16(q, i + 1), qend = i + 5;
    let ip = null, rcode = 0;
    if (qd !== 1 || (q[2] & 0x78)) rcode = 4; // only standard single-question queries
    else if (qtype === 1 || qtype === 255) {
      const key = name.toLowerCase();
      ip = this.hostMap[key] || this.hostMap['*'] || null;
      if (!ip && /^\d+\.\d+\.\d+\.\d+$/.test(name)) ip = name;
      if (!ip && this.o.transport) {
        try { ip = await this.o.transport.resolve(name); } catch (e) { ip = null; }
      }
      if (!ip) rcode = 3; // NXDOMAIN
    }
    this.log(`[dns] ${name} type ${qtype} -> ${ip || (rcode === 3 ? 'NXDOMAIN' : rcode ? 'NOTIMP' : 'no data')}`);
    const ans = ip ? [0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...ipBytes(ip)] : [];
    const r = new Uint8Array(qend + ans.length);
    r.set(q.subarray(0, Math.min(qend, q.length)));
    r[2] = 0x80 | (q[2] & 0x79); r[3] = 0x80 | rcode; // QR, RD copied, RA
    w16(r, 4, rcode === 4 ? 0 : 1); w16(r, 6, ip ? 1 : 0); w16(r, 8, 0); w16(r, 10, 0);
    r.set(ans, qend);
    this.udpOutput(dst, src, 53, sport, rcode === 4 ? r.subarray(0, 12) : r);
  }

  // ------------------------------------------------------------ TCP

  tcpInput(src, dst, d) {
    if (d.length < 20) return;
    if ((~checksum(d, 0, d.length, pseudoSum(src, dst, PROTO_TCP, d.length)) & 0xffff) !== 0) { this.log('[tcp] bad checksum'); return; }
    const seg = {
      sport: r16(d, 0), dport: r16(d, 2), seq: r32(d, 4), ack: r32(d, 8),
      flags: d[13] & 0x3f, win: r16(d, 14), data: d.subarray((d[12] >> 4) * 4),
      opts: d.subarray(20, (d[12] >> 4) * 4),
    };
    const key = `${ipStr(src)}:${seg.sport}>${ipStr(dst)}:${seg.dport}`;
    let c = this.tcp.get(key);
    if (c && (seg.flags & (SYN | ACK)) === SYN && ((seg.seq + 1) >>> 0) !== c.rcvNxt) {
      c.finish(); // the box reused the port for a new connection (it dropped the old one silently)
      c = null;
    }
    if (!c) {
      if (seg.flags & RST) return;
      if ((seg.flags & (SYN | ACK)) !== SYN) { this.rstFor(src, dst, seg); return; }
      c = new TcpConn(this, key, Uint8Array.from(src), Uint8Array.from(dst), seg);
      if (c.state !== 'closed') this.tcp.set(key, c);
      return;
    }
    c.input(seg);
  }

  rstFor(src, dst, seg) {
    const len = seg.data.length + (seg.flags & SYN ? 1 : 0) + (seg.flags & FIN ? 1 : 0);
    if (seg.flags & ACK) this.tcpOutput(dst, src, seg.dport, seg.sport, seg.ack, 0, RST, 0);
    else this.tcpOutput(dst, src, seg.dport, seg.sport, 0, (seg.seq + len) >>> 0, RST | ACK, 0);
  }

  tcpOutput(src, dst, sport, dport, seq, ack, flags, win, data = null, mss = 0) {
    const optLen = mss ? 4 : 0;
    const t = new Uint8Array(20 + optLen + (data ? data.length : 0));
    w16(t, 0, sport); w16(t, 2, dport); w32(t, 4, seq); w32(t, 8, ack);
    t[12] = ((20 + optLen) / 4) << 4; t[13] = flags; w16(t, 14, win);
    if (mss) { t[20] = 2; t[21] = 4; w16(t, 22, mss); }
    if (data) t.set(data, 20 + optLen);
    w16(t, 16, ~checksum(t, 0, t.length, pseudoSum(src, dst, PROTO_TCP, t.length)) & 0xffff);
    this.output(src, dst, PROTO_TCP, t);
  }
}

// FIFO of bytes with amortised O(1) append/consume.
class ByteQueue {
  constructor() { this.buf = new Uint8Array(4096); this.start = 0; this.end = 0; }
  get length() { return this.end - this.start; }
  push(d) {
    if (this.end + d.length > this.buf.length) {
      const len = this.length, cap = Math.max(this.buf.length, (len + d.length) * 2);
      if (cap > this.buf.length) {
        const nb = new Uint8Array(cap);
        nb.set(this.buf.subarray(this.start, this.end));
        this.buf = nb;
      } else this.buf.copyWithin(0, this.start, this.end);
      this.start = 0; this.end = len;
    }
    this.buf.set(d, this.end); this.end += d.length;
  }
  drop(n) { this.start += Math.min(n, this.length); if (this.start === this.end) this.start = this.end = 0; }
  view(off, n) { return this.buf.subarray(this.start + off, this.start + off + n); }
}

// One TCP connection from the box, terminated here and spliced to a relay stream.
class TcpConn {
  constructor(gw, key, src, dst, syn) {
    this.gw = gw; this.key = key; this.src = src; this.dst = dst;
    this.sport = syn.sport; this.dport = syn.dport;
    this.log = gw.log;
    this.rcvNxt = (syn.seq + 1) >>> 0;
    this.iss = (Math.random() * 0x100000000) >>> 0;
    this.sndUna = this.iss; this.sndNxt = this.iss;
    this.sndWnd = syn.win;
    this.mss = 536;
    for (let i = 0; i < syn.opts.length;) {
      const k = syn.opts[i];
      if (k === 0) break;
      if (k === 1) { i++; continue; }
      if (k === 2) this.mss = r16(syn.opts, i + 2);
      i += syn.opts[i + 1] || 1;
    }
    this.mss = Math.max(64, Math.min(this.mss, 1460));
    this.sendBuf = new ByteQueue(); // unacked + unsent bytes, starting at sndUna (after SYN)
    this.state = 'syn-rcvd-pending';
    this.remoteEof = false; this.finSent = false; this.finAcked = false; this.boxFin = false;
    this.rtoTimer = null; this.rtoMs = 3000; this.dupAcks = 0;
    this.boxBytes = 0; this.txBytes = 0;
    const host = ipStr(dst), port = syn.dport;
    this.log(`[tcp] box ${ipStr(src)}:${syn.sport} connecting to ${host}:${port} (mss ${this.mss}, win ${syn.win})`);
    gw.connLog.push({ host, port, time: Date.now() });
    if (!gw.o.transport) { this.log('[tcp] offline: refusing connection'); this.reset(); return; }
    this.conn = gw.o.transport.openTcp(host, port, {
      onOpen: () => this.opened(),
      onData: (d) => this.fromRemote(d),
      onEnd: () => { this.remoteEof = true; this.pump(); },
      onClose: (err) => this.remoteClosed(err),
    });
  }

  out(flags, data = null, seq = this.sndNxt, mss = 0) {
    this.gw.tcpOutput(this.dst, this.src, this.dport, this.sport, seq, this.rcvNxt, flags, 16384, data, mss);
  }

  opened() {
    if (this.state !== 'syn-rcvd-pending') return;
    this.state = 'syn-rcvd';
    this.log(`[tcp] ${ipStr(this.dst)}:${this.dport} connected`);
    this.sendSyn();
  }

  sendSyn() {
    this.out(SYN | ACK, null, this.iss, 1460);
    this.sndNxt = (this.iss + 1) >>> 0;
    this.armRto();
  }

  fromRemote(d) {
    if (this.state === 'closed') return;
    this.sendBuf.push(d);
    this.pump();
  }

  remoteClosed(err) {
    if (this.state === 'closed') return;
    if (this.state === 'syn-rcvd-pending') { this.log(`[tcp] ${ipStr(this.dst)}:${this.dport} connect failed: ${err || 'closed'}`); this.reset(); return; }
    if (err) { this.log(`[tcp] ${ipStr(this.dst)}:${this.dport} remote error: ${err}`); this.reset(); return; }
    this.remoteEof = true;
    this.pump();
  }

  // offset of sndNxt into sendBuf (sendBuf[0] is the byte at sndUna, after the SYN)
  get inFlight() { return (this.sndNxt - this.sndUna) >>> 0; }

  pump() {
    if (this.state !== 'established' && this.state !== 'close-wait') return;
    for (;;) {
      const off = this.inFlight;
      const avail = this.sendBuf.length - off;
      const wnd = this.sndWnd - this.inFlight;
      if (avail <= 0 || wnd <= 0) break;
      const n = Math.min(avail, wnd, this.mss);
      this.out(ACK | PSH, this.sendBuf.view(off, n));
      this.sndNxt = (this.sndNxt + n) >>> 0;
      this.txBytes += n;
    }
    if (this.remoteEof && !this.finSent && this.inFlight === this.sendBuf.length) {
      this.out(FIN | ACK);
      this.sndNxt = (this.sndNxt + 1) >>> 0;
      this.finSent = true;
    }
    if (this.inFlight || (this.sendBuf.length && this.sndWnd === 0)) this.armRto();
  }

  armRto() {
    if (this.rtoTimer) return;
    this.rtoTimer = setTimeout(() => this.rto(), this.rtoMs);
  }

  clearRto() { if (this.rtoTimer) { clearTimeout(this.rtoTimer); this.rtoTimer = null; } }

  rto() {
    this.rtoTimer = null;
    if (this.state === 'closed') return;
    // don't count time the data spends queued on the slow serial link
    if (this.gw.o.backlog && this.gw.o.backlog() > 0) { this.armRto(); return; }
    if (this.state === 'syn-rcvd') { this.log(`[tcp] ${ipStr(this.dst)}:${this.dport} resending SYN-ACK`); this.sendSyn(); return; }
    if (this.inFlight === 0 && this.sndWnd === 0 && this.sendBuf.length) {
      // zero-window probe: one byte
      this.out(ACK, this.sendBuf.view(0, 1), this.sndUna);
      this.armRto();
      return;
    }
    if (this.inFlight === 0) return;
    this.log(`[tcp] ${ipStr(this.dst)}:${this.dport} retransmit from ${this.inFlight} bytes in flight`);
    // go-back-N: rewind and resend
    if (this.finSent && !this.finAcked) this.finSent = false;
    this.sndNxt = this.sndUna;
    this.rtoMs = Math.min(this.rtoMs * 2, 30000);
    this.pump();
  }

  input(seg) {
    if (seg.flags & RST) { this.log(`[tcp] ${ipStr(this.dst)}:${this.dport} reset by box`); this.finish(); return; }
    if (seg.flags & SYN) {
      // retransmitted SYN while we wait for the relay, or after our SYN-ACK
      if (this.state === 'syn-rcvd') this.sendSyn();
      return;
    }
    if (this.state === 'syn-rcvd-pending') return;
    if (seg.flags & ACK) {
      if (seqLt(this.sndUna, seg.ack) && seqLe(seg.ack, this.sndNxt)) {
        let acked = (seg.ack - this.sndUna) >>> 0;
        if (this.state === 'syn-rcvd') { acked--; this.state = 'established'; this.log(`[tcp] ${ipStr(this.dst)}:${this.dport} established`); }
        if (this.finSent && seg.ack === this.sndNxt) { this.finAcked = true; acked = Math.max(0, acked - 1); }
        this.sendBuf.drop(acked);
        this.sndUna = seg.ack;
        this.clearRto();
        this.rtoMs = 3000;
        this.dupAcks = 0;
      } else if (seg.ack === this.sndUna && !seg.data.length && this.inFlight && seg.win === this.sndWnd && ++this.dupAcks === 3) {
        // fast retransmit: the box is missing the segment at sndUna
        if (this.finSent && !this.finAcked) this.finSent = false;
        this.sndNxt = this.sndUna;
      }
      this.sndWnd = seg.win;
    }
    let needAck = false;
    if (seg.data.length) {
      if (seg.seq === this.rcvNxt) {
        if (!this.boxFin) {
          this.rcvNxt = (this.rcvNxt + seg.data.length) >>> 0;
          this.toRemote(seg.data);
        }
      } else if (seqLt(seg.seq, this.rcvNxt) && seqLt(this.rcvNxt, (seg.seq + seg.data.length) >>> 0)) {
        // partial overlap with what we already have
        const skip = (this.rcvNxt - seg.seq) >>> 0;
        const rest = seg.data.subarray(skip);
        this.rcvNxt = (this.rcvNxt + rest.length) >>> 0;
        this.toRemote(rest);
      }
      needAck = true;
    }
    if ((seg.flags & FIN) && ((seg.seq + seg.data.length) >>> 0) === this.rcvNxt && !this.boxFin) {
      this.boxFin = true;
      this.rcvNxt = (this.rcvNxt + 1) >>> 0;
      if (this.state === 'established') this.state = 'close-wait';
      this.log(`[tcp] ${ipStr(this.dst)}:${this.dport} box closed its side`);
      if (this.conn) this.conn.end();
      needAck = true;
    } else if (seg.flags & FIN) needAck = true;
    if (needAck) this.out(ACK);
    if (this.boxFin && this.finAcked) { this.finish(); return; }
    this.pump();
  }

  toRemote(d) {
    this.boxBytes += d.length;
    if (this.conn) this.conn.send(Uint8Array.from(d));
  }

  reset() {
    if (this.state === 'closed') return;
    this.out(RST | ACK);
    this.finish();
  }

  finish() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.clearRto();
    if (this.conn) this.conn.close();
    this.gw.tcp.delete(this.key);
    this.log(`[tcp] ${ipStr(this.dst)}:${this.dport} closed (box sent ${this.boxBytes}, received ${this.txBytes} bytes)`);
  }
}
