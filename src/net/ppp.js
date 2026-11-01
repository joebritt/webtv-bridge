// PPP server side (the "ISP" end of the dial-up link): async-HDLC framing (RFC 1662), LCP
// (RFC 1661), optional PAP/CHAP (RFC 1334/1994) and IPCP (RFC 1332/1877). IPv4 datagrams are
// handed to `onIp(Uint8Array)`; `sendIp(Uint8Array)` frames a datagram towards the box.

export const PROTO_IP = 0x0021, PROTO_LCP = 0xc021, PROTO_PAP = 0xc023, PROTO_CHAP = 0xc223, PROTO_IPCP = 0x8021;

const FLAG = 0x7e, ESC = 0x7d;
const CONF_REQ = 1, CONF_ACK = 2, CONF_NAK = 3, CONF_REJ = 4, TERM_REQ = 5, TERM_ACK = 6, CODE_REJ = 7,
  PROTO_REJ = 8, ECHO_REQ = 9, ECHO_REP = 10, DISCARD_REQ = 11;

// ---------------------------------------------------------------- FCS-16 (RFC 1662 appendix C)

const FCS_TAB = new Uint16Array(256);
for (let b = 0; b < 256; b++) {
  let v = b;
  for (let i = 0; i < 8; i++) v = v & 1 ? (v >>> 1) ^ 0x8408 : v >>> 1;
  FCS_TAB[b] = v;
}
export function fcs16(data, fcs = 0xffff) {
  for (let i = 0; i < data.length; i++) fcs = (fcs >>> 8) ^ FCS_TAB[(fcs ^ data[i]) & 0xff];
  return fcs;
}

const hex = (n, w = 2) => n.toString(16).padStart(w, '0');
const ipStr = (a) => a.join('.');
const PROTO_NAMES = { [PROTO_IP]: 'IP', [PROTO_LCP]: 'LCP', [PROTO_PAP]: 'PAP', [PROTO_CHAP]: 'CHAP', [PROTO_IPCP]: 'IPCP',
  0x80fd: 'CCP', 0x8057: 'IPV6CP', 0x002d: 'VJC', 0x002f: 'VJU', 0x8029: 'ATCP' };

function parseOpts(data) {
  const opts = [];
  for (let i = 0; i + 2 <= data.length;) {
    const type = data[i], len = data[i + 1];
    if (len < 2 || i + len > data.length) return null;
    opts.push({ type, data: data.subarray(i + 2, i + len), raw: data.subarray(i, i + len) });
    i += len;
  }
  return opts;
}
const cat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const opt = (type, bytes) => Uint8Array.from([type, bytes.length + 2, ...bytes]);
const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

export class PppServer {
  // opts: { write(Uint8Array), onIp(pkt), onDown(why), log, localIp, peerIp, dns: [ip, ip], auth: null|'pap'|'chap' }
  constructor(o) {
    this.o = o;
    this.log = o.log || (() => {});
    this.write = o.write;
    this.localIp = o.localIp || [10, 0, 0, 1];
    this.peerIp = o.peerIp || [10, 0, 0, 2];
    this.dns = o.dns || [this.localIp, this.localIp];
    this.auth = o.auth || null;
    this.magic = (Math.random() * 0x100000000) >>> 0 || 1;
    this.rxBuf = new Uint8Array(4096);
    this.rxLen = 0; this.rxEsc = false; this.rxDrop = false;
    this.txAccm = 0xffffffff; // characters the box wants escaped (until LCP says otherwise)
    this.id = 1;
    this.timers = new Set();
    this.reset();
    this.stats = { rxFrames: 0, txFrames: 0, badFcs: 0 };
  }

  reset() {
    this.stop();
    this.lcp = { state: 'starting', ourAcked: false, theirAcked: false, retries: 0, reqId: 0 };
    this.ipcp = { ourAcked: false, theirAcked: false, retries: 0, reqId: 0, up: false };
    this.authDone = !this.auth;
    this.ipUp = false;
    this.peerMru = 1500;
    this.pendingAccm = 0xffffffff;
    this.txAccm = 0xffffffff;
  }

  // ------------------------------------------------------------ framing

  rxByte(b) {
    if (b === FLAG) {
      if (this.rxLen && !this.rxDrop) this.frame(this.rxBuf.subarray(0, this.rxLen));
      this.rxLen = 0; this.rxEsc = false; this.rxDrop = false;
      return;
    }
    if (this.rxDrop) return;
    if (b === ESC) { this.rxEsc = true; return; }
    if (this.rxEsc) { b ^= 0x20; this.rxEsc = false; }
    else if (b < 0x20) return; // flow-control chars inserted by the link are ignored (RFC 1662 4.2)
    if (this.rxLen >= this.rxBuf.length) { this.rxDrop = true; return; }
    this.rxBuf[this.rxLen++] = b;
  }

  frame(f) {
    if (f.length < 4) return;
    if (fcs16(f) !== 0xf0b8) { this.stats.badFcs++; this.log(`[ppp] bad FCS (len ${f.length})`); return; }
    this.stats.rxFrames++;
    let p = 0;
    if (f[0] === 0xff && f[1] === 0x03) p = 2;
    let proto = f[p++];
    if (!(proto & 1)) proto = (proto << 8) | f[p++];
    const data = f.slice(p, f.length - 2);
    this.packet(proto, data);
  }

  send(proto, data) {
    const hdr = [0xff, 0x03, proto >>> 8, proto & 0xff];
    // LCP always goes out with the default ACCM (RFC 1662 7.1)
    const accm = proto === PROTO_LCP ? 0xffffffff : this.txAccm;
    const out = [FLAG];
    let fcs = 0xffff;
    const put = (b) => {
      if (b === FLAG || b === ESC || (b < 0x20 && (accm >>> b) & 1)) out.push(ESC, b ^ 0x20);
      else out.push(b);
    };
    for (const b of hdr) { fcs = (fcs >>> 8) ^ FCS_TAB[(fcs ^ b) & 0xff]; put(b); }
    for (let i = 0; i < data.length; i++) { const b = data[i]; fcs = (fcs >>> 8) ^ FCS_TAB[(fcs ^ b) & 0xff]; put(b); }
    fcs ^= 0xffff;
    put(fcs & 0xff); put(fcs >>> 8);
    out.push(FLAG);
    this.stats.txFrames++;
    this.write(Uint8Array.from(out));
  }

  sendCtl(proto, code, id, body = new Uint8Array(0)) {
    const len = body.length + 4;
    this.send(proto, cat([Uint8Array.from([code, id, len >>> 8, len & 255]), body]));
  }

  sendIp(pkt) { if (this.ipUp) this.send(PROTO_IP, pkt); }

  timer(ms, fn) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  stop() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }

  // ------------------------------------------------------------ dispatch

  packet(proto, data) {
    if (proto === PROTO_IP) { if (this.ipUp) this.o.onIp(data); return; }
    const code = data[0], id = data[1], len = Math.min((data[2] << 8) | data[3], data.length);
    const body = data.subarray(4, len);
    switch (proto) {
      case PROTO_LCP: this.lcpPacket(code, id, body, data); return;
      case PROTO_PAP: this.papPacket(code, id, body); return;
      case PROTO_CHAP: this.chapPacket(code, id, body); return;
      case PROTO_IPCP: if (this.lcp.state === 'opened') this.ipcpPacket(code, id, body); return;
    }
    this.log(`[ppp] rejecting protocol ${PROTO_NAMES[proto] || '0x' + hex(proto, 4)}`);
    if (this.lcp.state === 'opened') this.sendCtl(PROTO_LCP, PROTO_REJ, this.id++, cat([Uint8Array.from([proto >>> 8, proto & 255]), data]));
  }

  // ------------------------------------------------------------ LCP

  lcpRequest() {
    const L = this.lcp;
    if (L.ourAcked || L.state === 'closed') return;
    if (L.retries++ >= 10) { this.down('LCP negotiation timed out'); return; }
    L.reqId = this.id++ & 255;
    const opts = [opt(5, be32(this.magic))];
    if (this.auth === 'pap') opts.push(opt(3, [0xc0, 0x23]));
    if (this.auth === 'chap') opts.push(opt(3, [0xc2, 0x23, 5])); // MD5
    this.sendCtl(PROTO_LCP, CONF_REQ, L.reqId, cat(opts));
    clearTimeout(L.timer);
    L.timer = this.timer(3000, () => this.lcpRequest());
  }

  start() {
    this.log('[ppp] link up, starting LCP');
    this.lcp.state = 'reqsent';
    this.lcpRequest();
  }

  lcpPacket(code, id, body, raw) {
    const L = this.lcp;
    switch (code) {
      case CONF_REQ: {
        if (L.state === 'opened') { this.log('[ppp] LCP renegotiation'); this.reset(); L.state = 'reqsent'; this.lcpRequest(); }
        const opts = parseOpts(body);
        if (!opts) return;
        const rej = [], nak = [];
        let accm = 0xffffffff, mru = 1500;
        const desc = [];
        for (const o of opts) {
          switch (o.type) {
            case 1: mru = (o.data[0] << 8) | o.data[1]; desc.push(`mru=${mru}`); break;
            case 2: accm = ((o.data[0] << 24) | (o.data[1] << 16) | (o.data[2] << 8) | o.data[3]) >>> 0; desc.push(`accm=${hex(accm, 8)}`); break;
            case 3: {
              // the box wants *us* to authenticate: we can't really, so reject
              desc.push(`auth=${hex((o.data[0] << 8) | o.data[1], 4)}`); rej.push(o.raw); break;
            }
            case 5: desc.push(`magic=${hex(((o.data[0] << 24) | (o.data[1] << 16) | (o.data[2] << 8) | o.data[3]) >>> 0, 8)}`); break;
            case 7: desc.push('pfc'); break;
            case 8: desc.push('acfc'); break;
            default: desc.push(`?${o.type}`); rej.push(o.raw);
          }
        }
        this.log(`[ppp] LCP ConfReq from box: ${desc.join(' ')}${rej.length ? ' (rejecting some)' : ''}`);
        if (rej.length) { this.sendCtl(PROTO_LCP, CONF_REJ, id, cat(rej)); return; }
        if (nak.length) { this.sendCtl(PROTO_LCP, CONF_NAK, id, cat(nak)); return; }
        this.sendCtl(PROTO_LCP, CONF_ACK, id, body);
        L.theirAcked = true;
        this.peerMru = mru;
        this.pendingAccm = accm;
        if (L.state === 'starting') { L.state = 'reqsent'; this.lcpRequest(); }
        this.lcpCheckOpen();
        return;
      }
      case CONF_ACK:
        if (id !== L.reqId) return;
        L.ourAcked = true;
        this.lcpCheckOpen();
        return;
      case CONF_NAK: case CONF_REJ: {
        if (id !== L.reqId) return;
        const opts = parseOpts(body) || [];
        this.log(`[ppp] LCP ${code === CONF_NAK ? 'Nak' : 'Rej'} of our options ${opts.map((o) => o.type).join(',')}`);
        if (opts.some((o) => o.type === 3)) {
          if (code === CONF_NAK && opts.find((o) => o.type === 3).data[0] === 0xc0) this.auth = 'pap';
          else { this.log('[ppp] box refused authentication, continuing without'); this.auth = null; this.authDone = true; }
        }
        if (code === CONF_REJ && opts.some((o) => o.type === 5)) this.magic = 0;
        L.retries = 0;
        this.lcpRequest();
        return;
      }
      case TERM_REQ:
        this.log('[ppp] LCP Terminate-Request from box');
        this.sendCtl(PROTO_LCP, TERM_ACK, id);
        this.down('terminated by box', true);
        return;
      case TERM_ACK: return;
      case ECHO_REQ:
        if (L.state === 'opened') this.sendCtl(PROTO_LCP, ECHO_REP, id, cat([Uint8Array.from(be32(this.magic)), body.subarray(4)]));
        return;
      case ECHO_REP: case DISCARD_REQ: return;
      case CODE_REJ: this.log('[ppp] LCP Code-Reject from box'); return;
      case PROTO_REJ: this.log(`[ppp] box rejected protocol 0x${hex((body[0] << 8) | body[1], 4)}`); return;
      default:
        this.sendCtl(PROTO_LCP, CODE_REJ, this.id++ & 255, raw);
    }
  }

  lcpCheckOpen() {
    const L = this.lcp;
    if (L.state === 'opened' || !L.ourAcked || !L.theirAcked) return;
    L.state = 'opened';
    this.txAccm = this.pendingAccm;
    this.log(`[ppp] LCP opened (box mru=${this.peerMru} accm=${hex(this.txAccm, 8)})`);
    if (this.auth === 'chap') this.chapChallenge();
    // the box may start IPCP right away; we send our IPCP request once authentication is done
    if (this.authDone) this.ipcpStart();
  }

  // ------------------------------------------------------------ PAP / CHAP

  papPacket(code, id, body) {
    if (code !== 1) return;
    const ul = body[0], user = String.fromCharCode(...body.subarray(1, 1 + ul));
    const pl = body[1 + ul], pass = body.subarray(2 + ul, 2 + ul + pl);
    this.log(`[ppp] PAP login: user "${user}" (password ${pl} bytes)`);
    if (this.o.onAuth) this.o.onAuth({ method: 'pap', user, password: String.fromCharCode(...pass) });
    const msg = Array.from('Welcome', (c) => c.charCodeAt(0));
    this.sendCtl(PROTO_PAP, 2, id, Uint8Array.from([msg.length, ...msg]));
    if (!this.authDone) { this.authDone = true; this.ipcpStart(); }
  }

  chapChallenge() {
    this.chapId = this.id++ & 255;
    const chal = Array.from({ length: 16 }, () => (Math.random() * 256) | 0);
    const name = Array.from('webtv-emu', (c) => c.charCodeAt(0));
    this.sendCtl(PROTO_CHAP, 1, this.chapId, Uint8Array.from([16, ...chal, ...name]));
  }

  chapPacket(code, id, body) {
    if (code !== 2) return;
    const vl = body[0], user = String.fromCharCode(...body.subarray(1 + vl));
    this.log(`[ppp] CHAP response: user "${user}" (accepted)`);
    if (this.o.onAuth) this.o.onAuth({ method: 'chap', user });
    this.sendCtl(PROTO_CHAP, 3, id, Uint8Array.from(Array.from('Welcome', (c) => c.charCodeAt(0))));
    if (!this.authDone) { this.authDone = true; this.ipcpStart(); }
  }

  // ------------------------------------------------------------ IPCP

  ipcpStart() {
    const I = this.ipcp;
    if (I.started) return;
    I.started = true;
    this.ipcpRequest();
    if (I.deferred) { const d = I.deferred; I.deferred = null; this.ipcpPacket(...d); }
  }

  ipcpRequest() {
    const I = this.ipcp;
    if (I.ourAcked || this.lcp.state !== 'opened') return;
    if (I.retries++ >= 10) { this.down('IPCP negotiation timed out'); return; }
    I.reqId = this.id++ & 255;
    this.sendCtl(PROTO_IPCP, CONF_REQ, I.reqId, I.noAddr ? new Uint8Array(0) : opt(3, this.localIp));
    clearTimeout(I.timer);
    I.timer = this.timer(3000, () => this.ipcpRequest());
  }

  ipcpPacket(code, id, body) {
    const I = this.ipcp;
    if (!this.authDone) { if (code === CONF_REQ) I.deferred = [code, id, body]; return; }
    switch (code) {
      case CONF_REQ: {
        const opts = parseOpts(body);
        if (!opts) return;
        const rej = [], nak = [];
        const desc = [];
        for (const o of opts) {
          const want = { 3: this.peerIp, 129: this.dns[0], 131: this.dns[1] }[o.type];
          if (want && o.data.length === 4) {
            desc.push(`${o.type}=${ipStr(o.data)}`);
            if (ipStr(o.data) !== ipStr(want)) nak.push(opt(o.type, want));
          } else { desc.push(`?${o.type}`); rej.push(o.raw); }
        }
        this.log(`[ppp] IPCP ConfReq from box: ${desc.join(' ')}`);
        if (rej.length) { this.sendCtl(PROTO_IPCP, CONF_REJ, id, cat(rej)); return; }
        if (nak.length) { this.sendCtl(PROTO_IPCP, CONF_NAK, id, cat(nak)); return; }
        this.sendCtl(PROTO_IPCP, CONF_ACK, id, body);
        I.theirAcked = true;
        this.ipcpCheckOpen();
        return;
      }
      case CONF_ACK: if (id === I.reqId) { I.ourAcked = true; this.ipcpCheckOpen(); } return;
      case CONF_NAK: case CONF_REJ:
        if (id === I.reqId) {
          const opts = parseOpts(body) || [];
          this.log(`[ppp] box ${code === CONF_NAK ? 'Nak' : 'Rej'}-ed our IPCP options: ${opts.map((o) => `${o.type}=${Array.from(o.data).join('.')}`).join(' ')}`);
          if (code === CONF_REJ && opts.some((o) => o.type === 3)) I.noAddr = true;
          I.retries = 0; this.ipcpRequest();
        }
        return;
      case TERM_REQ: this.sendCtl(PROTO_IPCP, TERM_ACK, id); this.ipUp = false; I.ourAcked = I.theirAcked = false; return;
      case TERM_ACK: return;
      default: this.sendCtl(PROTO_IPCP, CODE_REJ, this.id++ & 255, Uint8Array.from([code, id, 0, body.length + 4, ...body]));
    }
  }

  ipcpCheckOpen() {
    const I = this.ipcp;
    if (this.ipUp || !I.ourAcked || !I.theirAcked) return;
    this.ipUp = true;
    this.log(`[ppp] IPCP up: box ${ipStr(this.peerIp)}, gateway ${ipStr(this.localIp)}, dns ${ipStr(this.dns[0])}`);
    if (this.o.onUp) this.o.onUp();
  }

  // ------------------------------------------------------------ teardown

  terminate() {
    if (this.lcp.state === 'opened') this.sendCtl(PROTO_LCP, TERM_REQ, this.id++ & 255);
    this.down('local close');
  }

  down(why, remote) {
    if (this.lcp.state === 'closed') return;
    this.log(`[ppp] down: ${why}`);
    this.stop();
    this.reset();
    this.lcp.state = 'closed';
    if (this.o.onDown) this.o.onDown(why, remote);
  }
}
