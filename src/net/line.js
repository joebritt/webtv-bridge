// Network "phone line" for the emulated modem: answers the call with a PPP server, routes the
// box's IP traffic through IpGateway and relays its TCP connections over WebSockets to
// tools/relay.mjs. Works in browsers/workers and in Node (global WebSocket and fetch).
//
//   import { createNetworkLine } from '../src/net/line.js';
//   modem.line = createNetworkLine({ relayUrl: 'ws://localhost:8081', hostMap: { 'example.com': '1.2.3.4' }, log });

import { PppServer } from './ppp.js';
import { IpGateway } from './ip.js';

// WebSocket relay transport. Protocol (see tools/relay.mjs): ws://relay/tcp?host=H&port=P, relay
// sends text "OK" once connected (or "ERR <msg>" and closes), then binary frames both ways; a
// text "EOF" in either direction half-closes the TCP stream.
export function createRelayTransport(relayUrl, log = () => {}) {
  const base = relayUrl.replace(/\/+$/, '');
  const httpBase = base.replace(/^ws/, 'http');
  return {
    openTcp(host, port, h) {
      let ws, open = false, closed = false;
      const queue = [];
      try {
        ws = new WebSocket(`${base}/tcp?host=${encodeURIComponent(host)}&port=${port}`);
      } catch (e) {
        setTimeout(() => h.onClose(String(e.message || e)), 0);
        return { send() {}, end() {}, close() {} };
      }
      ws.binaryType = 'arraybuffer';
      let err = null;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          if (ev.data === 'OK') { open = true; h.onOpen(); for (const q of queue) ws.send(q); queue.length = 0; }
          else if (ev.data === 'EOF') h.onEnd();
          else if (ev.data.startsWith('ERR')) err = ev.data.slice(4) || 'error';
          return;
        }
        h.onData(new Uint8Array(ev.data));
      };
      ws.onerror = () => { err = err || `relay connection to ${base} failed`; };
      ws.onclose = () => { if (!closed) { closed = true; h.onClose(err); } };
      const sendRaw = (d) => {
        if (closed) return;
        if (open && ws.readyState === 1) ws.send(d); else queue.push(d);
      };
      return {
        send: (d) => sendRaw(d),
        end: () => sendRaw('EOF'),
        close: () => { if (!closed) { closed = true; try { ws.close(); } catch (e) { /* ignore */ } } },
      };
    },
    async resolve(name) {
      const r = await fetch(`${httpBase}/dns?name=${encodeURIComponent(name)}`);
      if (!r.ok) return null;
      const j = await r.json();
      return j.address || null;
    },
  };
}

// In-page service transport: connections to the service address go straight to `service`
// (src/wtvsrv/service.js) without leaving the page; anything else goes to `fallback` (the
// relay) or is refused.
// Boxes start out talking to WebTV's own addresses (NVRAM and ROM defaults such as 207.79.34.4:1601
// and 10.0.128.1:1615), so every connection to a WTVP port (1600-1699) goes to the service.
const isServiceHost = (host, port, serviceIp) => host === serviceIp || (port >= 1600 && port <= 1699);

export function createServiceTransport(service, { serviceIp = '10.0.0.1', fallback = null } = {}) {
  return {
    openTcp(host, port, h) {
      if (!isServiceHost(host, port, serviceIp)) {
        if (fallback) return fallback.openTcp(host, port, h);
        setTimeout(() => h.onClose('no route (offline)'), 0);
        return { send() {}, end() {}, close() {} };
      }
      let closed = false;
      const conn = service.openConnection(port, {
        send: (d) => { if (!closed) h.onData(d); },
        close: () => { if (!closed) { closed = true; h.onEnd(); setTimeout(() => h.onClose(null), 0); } },
      });
      setTimeout(() => h.onOpen(), 0);
      return {
        send: (d) => { if (!closed) conn.receive(d instanceof Uint8Array ? d : new Uint8Array(d)); },
        end: () => { if (!closed) { closed = true; conn.closed = true; setTimeout(() => h.onClose(null), 0); } },
        close: () => { closed = true; conn.closed = true; },
      };
    },
    resolve: fallback && fallback.resolve ? (n) => fallback.resolve(n) : async () => null,
  };
}

// The bridge's WTVP server setting (WEBTV_LPT_BRIDGE.md §10.7): every connection to a WTVP port
// (1600-1699), whatever address the build dials, goes to `target` ('host' or 'host:port';
// the port stays the box's unless given). Other connections pass through.
export function redirectWtvp(transport, target, log = () => {}) {
  const [host, p] = target.split(':');
  return {
    ...transport,
    openTcp(h, port, handler) {
      if (port >= 1600 && port <= 1699) {
        const to = p ? Number(p) : port;
        log(`[net] WTVP ${h}:${port} -> ${host}:${to}`);
        return transport.openTcp(host, to, handler);
      }
      return transport.openTcp(h, port, handler);
    },
  };
}

// opts: { relayUrl, service, hostMap, wtvp, log, auth: null|'pap'|'chap', localIp, peerIp }
export function createNetworkLine(opts = {}) {
  const log = opts.log || (() => {});
  const relay = opts.relayUrl ? createRelayTransport(opts.relayUrl, log) : null;
  let transport = opts.service ? createServiceTransport(opts.service, { fallback: relay }) : relay;
  if (opts.wtvp && relay) transport = redirectWtvp(relay, opts.wtvp, log); // the server the user set, not the in-page one
  const toIp = (s) => (typeof s === 'string' ? s.split('.').map(Number) : s);
  const localIp = toIp(opts.localIp || '10.0.0.1');
  const peerIp = toIp(opts.peerIp || '10.0.0.2');
  let ppp = null, gw = null;

  const line = {
    onData: null,
    onClose: null,
    backlog: null, // set by the modem: bytes queued towards the box
    stats: () => ({ ppp: ppp && ppp.stats, tcp: gw ? gw.tcp.size : 0, connections: gw ? gw.connLog : [] }),
    connect(number) {
      log(`[net] answering call to ${number}${opts.service ? ' (built-in service)' : ''}${opts.relayUrl ? ` (relay ${opts.relayUrl})` : opts.service ? '' : ' (offline: no relay)'}`);
      gw = new IpGateway({
        send: (p) => ppp.sendIp(p),
        transport,
        log,
        gateway: localIp,
        hostMap: opts.hostMap,
        backlog: () => (line.backlog ? line.backlog() : 0),
      });
      ppp = new PppServer({
        localIp, peerIp, auth: opts.auth || null, log,
        write: (bytes) => { if (line.onData) for (const b of bytes) line.onData(b); },
        onIp: (p) => gw.input(p),
        onAuth: opts.onAuth,
        onDown: (why) => {
          for (const c of [...gw.tcp.values()]) c.finish();
          if (line.onClose) line.onClose();
        },
      });
      // like a real ISP, start LCP shortly after CONNECT
      const p = ppp;
      const kick = () => {
        if (ppp !== p || p.lcp.state !== 'starting') return;
        if (line.onData) p.start(); else setTimeout(kick, 250); // wait for the modem's CONNECT
      };
      setTimeout(kick, 500);
      return Promise.resolve(true);
    },
    send(b) { if (ppp) ppp.rxByte(b); },
    close() {
      if (!ppp) return;
      const p = ppp; ppp = null;
      p.o.onDown = null;
      p.stop();
      if (p.lcp.state !== 'closed') p.down('hangup');
      if (gw) for (const c of [...gw.tcp.values()]) c.finish();
    },
  };
  return line;
}
