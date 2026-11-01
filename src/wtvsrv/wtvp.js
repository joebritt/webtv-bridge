// One WTVP connection between the box and the in-page service: request parsing (including
// "SECURE ON" and RC4-encrypted requests) and response framing. Behaviour follows zefie's
// minisrv (app.js processRequest / sendToClient):
//
//   - A request is an HTTP-like header block ("GET url" / "POST url" + "Name: value" lines,
//     ended by a blank line; \r\n, \n\r\n and \n\n all occur), then Content-length bytes of body.
//   - A "SECURE ON" block (in clear, carrying wtv-ticket and wtv-incarnation) switches the
//     connection to RC4: everything the box sends after it is encrypted with session key 1,
//     and response bodies are encrypted with session key 2 ("wtv-encrypted: true").
//   - Responses: status line, then headers with Connection second and Content-type last,
//     "\n" line endings, a blank line, the body.

import { WTVSec } from './wtvsec.js';
import { concat, latin1, fromLatin1 } from './crypto.js';

export function parseHeaderBlock(text) {
  const h = { headers: {}, secure: false, method: null, url: null };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    if (/^SECURE ON/.test(line)) { h.secure = true; continue; }
    const m = /^(GET|PUT|POST) (.*?)(?: HTTP\/[\d.]+)?$/.exec(line);
    if (m && !h.method) { h.method = m[1]; h.url = m[2]; continue; }
    const i = line.indexOf(':');
    if (i > 0) {
      const k = line.slice(0, i), v = line.slice(i + 1).replace(/^ /, '');
      const lk = k.toLowerCase();
      if (lk in h.headers) h.headers[lk] = [].concat(h.headers[lk], v); else h.headers[lk] = v;
    }
  }
  return h;
}

function findHeaderEnd(buf) {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] !== 10) continue;
    if (buf[i + 1] === 10) return [i, i + 2];                                      // \n\n
    if (buf[i + 1] === 13 && buf[i + 2] === 10) return [i, i + 3];               // \n\r\n
  }
  return null;
}

export class WtvpConnection {
  // service: { handle(request, conn) -> Promise<{ head: string, body: Uint8Array|string }> }
  // io: { send(Uint8Array), close() }
  constructor(service, io, { log = () => {}, port = 0 } = {}) {
    this.service = service;
    this.io = io;
    this.log = log;
    this.port = port;
    this.sec = null;          // WTVSec once SECURE ON
    this.plain = new Uint8Array(0);
    this.outer = null;        // headers of the SECURE ON block, merged into the next request
    this.queue = Promise.resolve();
    this.closed = false;
  }

  receive(data) {
    if (this.sec) {
      // a fresh SECURE ON block at a request boundary arrives in clear
      if (this.plain.length === 0 && fromLatin1(data.subarray(0, 9)) === 'SECURE ON') this.sec = null;
      else data = this.sec.decrypt(data);
    }
    this.plain = concat(this.plain, data);
    this.pump();
  }

  pump() {
    for (;;) {
      const end = findHeaderEnd(this.plain);
      if (!end) return;
      const block = parseHeaderBlock(fromLatin1(this.plain.subarray(0, end[0])));
      if (block.secure && !block.method) {
        // switch to RC4; whatever follows the block is already encrypted
        const rest = this.plain.subarray(end[1]);
        this.outer = block.headers;
        this.sec = this.service.connectionSecurity(block.headers);
        this.plain = rest.length ? this.sec.decrypt(rest) : new Uint8Array(0);
        continue;
      }
      const len = Number(block.headers['content-length'] || 0);
      if (this.plain.length < end[1] + len) return; // wait for the body
      const body = this.plain.slice(end[1], end[1] + len);
      this.plain = this.plain.slice(end[1] + len);
      const headers = { ...(this.outer || {}), ...block.headers };
      this.outer = null;
      const req = { method: block.method || 'GET', url: block.url || '', headers, body, secure: !!this.sec, port: this.port };
      if (headers['wtv-incarnation'] && this.sec) this.sec.setIncarnation(headers['wtv-incarnation']);
      this.queue = this.queue.then(() => this.dispatch(req));
    }
  }

  async dispatch(req) {
    let res;
    try {
      res = await this.service.handle(req, this);
    } catch (e) {
      this.log(`[wtvsrv] ${req.url}: ${e.stack || e}`);
      res = { head: '500 The service had a problem with this page\nContent-Type: text/html', body: '' };
    }
    if (!this.closed) this.send(res);
  }

  // head: "200 OK\nName: value\n..." (as minisrv's service scripts write it)
  send({ head, body = '' }) {
    let data = typeof body === 'string' ? latin1(body) : body;
    const lines = head.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
    const status = lines.shift();
    let fields = lines.map((l) => { const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1).replace(/^ /, '')]; });
    const get = (k) => fields.find(([n]) => n.toLowerCase() === k.toLowerCase());
    const drop = (k) => { fields = fields.filter(([n]) => n.toLowerCase() !== k.toLowerCase()); };
    let close = false;
    if (get('wtv-connection-close')) { close = true; drop('wtv-connection-close'); }
    if (!get('Connection')) fields.unshift(['Connection', 'Keep-Alive']);
    else if (get('Connection')[1].toLowerCase() === 'close') close = true;
    const ctype = get('Content-Type');
    drop('Content-Type'); drop('Content-length');
    const extra = this.service.extraHeaders ? this.service.extraHeaders(this) : [];
    if (this.sec) {
      drop('wtv-encrypted');
      extra.unshift(['wtv-encrypted', 'true']);
      if (data.length) data = this.sec.encrypt(data);
    }
    // Connection second, then wtv-encrypted / wtv-ticket, ..., Content-type last
    const conn = get('Connection'); drop('Connection');
    fields = [conn, ...extra, ...fields, ['Content-length', String(data.length)]];
    if (ctype) fields.push(['Content-type', ctype[1].split(';')[0]]);
    const text = `${status}\n${fields.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n`;
    this.io.send(concat(latin1(text), data));
    if (close) { this.closed = true; this.io.close(); }
  }
}

export { WTVSec };
