// WebSocket -> TCP relay for the emulated box's network connection (dependency-free; the
// RFC 6455 handshake and framing are implemented here).
//
//   node tools/relay.mjs [--port 8081] [--target HOST] [--map FROM=TO]... [--host-map NAME=IP]...
//
// Endpoints:
//   ws://localhost:8081/tcp?host=H&port=P   one TCP connection. The relay sends text "OK" once
//                                           connected (or "ERR msg" and closes), then binary
//                                           frames in both directions; text "EOF" half-closes.
//   http://localhost:8081/dns?name=N        {"name":N,"address":"a.b.c.d"} (CORS enabled)
//
// Destination rewriting (the box connects to hardcoded WebTV service addresses):
//   --target 127.0.0.1                send every connection to this host (port unchanged)
//   --map 207.79.34.0/24=127.0.0.1    rewrite a host / CIDR block (optionally :port on either side,
//   --map 10.0.0.1:1601=srv:1615      e.g. to point one service port somewhere else)
//   --host-map name=ip                answer DNS lookups for `name` (or '*') with `ip`

import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const multi = (name) => args.flatMap((a, i) => (a === '--' + name ? [args[i + 1]] : []));

const PORT = Number(opt('port', '8081'));
const BIND = opt('bind', '127.0.0.1');
const TARGET = opt('target', null);
const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(ts(), ...a);

// ---------------------------------------------------------------- destination mapping

const ip4 = (s) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? s.split('.').reduce((n, x) => ((n << 8) | Number(x)) >>> 0, 0) : null);
const splitHostPort = (s) => { const m = /^(.*?)(?::(\d+))?$/.exec(s); return { host: m[1], port: m[2] ? Number(m[2]) : null }; };
const maps = multi('map').map((spec) => {
  const [from, to] = spec.split('=');
  const f = splitHostPort(from), t = splitHostPort(to);
  const [h, bits] = f.host.split('/');
  return { host: h, net: ip4(h), bits: bits === undefined ? 32 : Number(bits), port: f.port, to: t };
});
const hostMap = Object.fromEntries(multi('host-map').map((s) => s.split('=')));

function mapDest(host, port) {
  const a = ip4(host);
  for (const m of maps) {
    if (m.port !== null && m.port !== port) continue;
    const hit = m.net !== null && a !== null
      ? (m.bits === 0 || ((a ^ m.net) >>> (32 - m.bits)) === 0)
      : m.host.toLowerCase() === host.toLowerCase();
    if (hit) return { host: m.to.host || host, port: m.to.port || port };
  }
  if (TARGET) return { host: TARGET, port };
  return { host, port };
}

// ---------------------------------------------------------------- WebSocket (RFC 6455)

class WsConn {
  constructor(sock, head) {
    this.sock = sock;
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.frag = null; this.fragOp = 0;
    this.closed = false;
    this.onText = () => {}; this.onBinary = () => {}; this.onClose = () => {};
    sock.setNoDelay(true);
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    sock.on('close', () => this.gone());
    sock.on('error', () => this.gone());
    if (this.buf.length) setImmediate(() => this.parse());
  }

  gone() { if (!this.closed) { this.closed = true; this.onClose(); } }

  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 15, masked = b[1] & 0x80;
      let len = b[1] & 127, p = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); p = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); p = 10; }
      const need = p + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let payload = b.subarray(p + (masked ? 4 : 0), need);
      if (masked) {
        const mask = b.subarray(p, p + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = b.subarray(need);
      this.frame(fin, op, payload);
    }
  }

  frame(fin, op, payload) {
    if (op === 0) { // continuation
      if (!this.frag) return;
      this.frag.push(payload);
      if (fin) { const all = Buffer.concat(this.frag); this.frag = null; this.message(this.fragOp, all); }
      return;
    }
    if (op === 1 || op === 2) {
      if (fin) this.message(op, payload); else { this.frag = [payload]; this.fragOp = op; }
      return;
    }
    if (op === 8) { this.sendFrame(8, payload.subarray(0, 2)); this.sock.end(); this.gone(); return; }
    if (op === 9) { this.sendFrame(10, payload); return; }
  }

  message(op, data) { if (op === 1) this.onText(data.toString('utf8')); else this.onBinary(data); }

  sendFrame(op, data) {
    if (this.sock.destroyed) return;
    const len = data.length;
    const hdr = len < 126 ? Buffer.from([0x80 | op, len])
      : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255])
        : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
    this.sock.write(Buffer.concat([hdr, data]));
  }

  text(s) { this.sendFrame(1, Buffer.from(s, 'utf8')); }
  binary(d) { this.sendFrame(2, d); }
  close(code = 1000) {
    if (this.closed) return;
    this.sendFrame(8, Buffer.from([code >> 8, code & 255]));
    this.sock.end();
    this.gone();
  }
}

// ---------------------------------------------------------------- endpoints

let nextId = 1;

function relayTcp(ws, host, port) {
  const id = nextId++;
  const dest = mapDest(host, port);
  const via = dest.host !== host || dest.port !== port ? ` -> ${dest.host}:${dest.port}` : '';
  log(`[tcp#${id}] box connects to ${host}:${port}${via}`);
  let up = 0, down = 0, first = true;
  const sock = net.connect({ host: dest.host, port: dest.port });
  sock.setNoDelay(true);
  sock.on('connect', () => { log(`[tcp#${id}] connected`); ws.text('OK'); });
  sock.on('data', (d) => { down += d.length; ws.binary(d); });
  sock.on('end', () => { log(`[tcp#${id}] remote closed its side`); ws.text('EOF'); });
  sock.on('error', (e) => { log(`[tcp#${id}] error: ${e.message}`); ws.text('ERR ' + e.message); });
  sock.on('close', () => { log(`[tcp#${id}] closed (box sent ${up} bytes, received ${down})`); ws.close(); });
  ws.onBinary = (d) => {
    up += d.length;
    if (first && process.env.RELAY_DUMP !== '0') {
      // show the start of what the box sends (usually a WTVP/HTTP request line)
      const s = d.subarray(0, 600).toString('latin1').replace(/[^\x20-\x7e\n]/g, '.');
      log(`[tcp#${id}] box sends:\n  ${s.split('\n').join('\n  ')}`);
      first = false;
    }
    sock.write(d);
  };
  ws.onText = (t) => { if (t === 'EOF') sock.end(); };
  ws.onClose = () => sock.destroy();
}

async function lookup(name) {
  const key = name.toLowerCase();
  if (hostMap[key]) return hostMap[key];
  if (hostMap['*']) return hostMap['*'];
  const r = await dns.promises.lookup(name, { family: 4 });
  return r.address;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (url.pathname === '/dns') {
    const name = url.searchParams.get('name') || '';
    try {
      const address = await lookup(name);
      log(`[dns] ${name} -> ${address}`);
      res.writeHead(200, cors).end(JSON.stringify({ name, address }));
    } catch (e) {
      log(`[dns] ${name} -> ${e.code || e.message}`);
      res.writeHead(404, cors).end(JSON.stringify({ name, error: e.code || e.message }));
    }
    return;
  }
  res.writeHead(404, cors).end('{"error":"not found"}');
});

server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/tcp' || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const ws = new WsConn(sock, head);
  const host = url.searchParams.get('host'), port = Number(url.searchParams.get('port'));
  if (!host || !(port > 0 && port < 65536)) { ws.text('ERR bad host/port'); ws.close(1008); return; }
  relayTcp(ws, host, port);
});

server.listen(PORT, BIND, () => {
  log(`relay listening on ws://${BIND}:${PORT} (tcp: /tcp?host=H&port=P, dns: /dns?name=N)`);
  if (TARGET) log(`all connections go to ${TARGET}`);
  for (const m of maps) log(`map ${m.host}${m.bits !== 32 ? '/' + m.bits : ''}${m.port ? ':' + m.port : ''} -> ${m.to.host || '(same)'}${m.to.port ? ':' + m.to.port : ''}`);
});
