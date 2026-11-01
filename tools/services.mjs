// Starts and stops the helper processes the emulated box talks to, for the dev server's
// /api/services endpoints:
//
//   minisrv  zefie's WebTV service emulator (services/minisrv, `node app.js`), wtv-1800 on :1615
//   relay    tools/relay.mjs on :8081; mode "local" sends every connection to 127.0.0.1
//            (minisrv), mode "direct" connects wherever the box asks
//
// A service already listening on its port that we did not start is reported as "external".
//
// Ownership: a page passes its window id (X-WebTV-Owner) when it starts a service and holds
// an event stream open (/api/services/lease?owner=ID) while it is open. When the last stream
// of that window closes and does not come back within LEASE_GRACE_MS (long enough to survive
// a reload), the services it started are stopped, so closing the window leaves no processes.
// Services started without an owner (e.g. with curl) run until the dev server exits.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

const MAX_LOG = 2000;
const LEASE_GRACE_MS = 5000;

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const finish = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(500, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

class Service {
  constructor(name, { cwd, args, port, ready = 30000 }) {
    this.name = name;
    this.cwd = cwd;
    this.args = args;   // (opts) => argv for node
    this.port = port;
    this.readyMs = ready;
    this.proc = null;
    this.state = 'stopped'; // stopped | starting | running | stopping
    this.opts = {};
    this.log = [];      // [seq, text]
    this.seq = 0;
    this.exitInfo = null;
    this.owner = null;  // window id of the page that started it, if any
  }

  append(text) {
    for (const line of text.split(/\r?\n/)) {
      if (line === '') continue;
      this.log.push([++this.seq, line]);
    }
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }

  async status() {
    let state = this.state;
    if (!this.proc && state === 'stopped' && await portOpen(this.port)) state = 'external';
    return { state, pid: this.proc ? this.proc.pid : null, port: this.port, opts: this.opts, exit: this.exitInfo, seq: this.seq };
  }

  async start(opts = {}, owner = null) {
    if (this.proc) return;
    if (await portOpen(this.port)) throw new Error(`port ${this.port} is already in use by another process`);
    this.opts = opts;
    this.owner = owner;
    this.exitInfo = null;
    const argv = this.args(opts);
    this.append(`$ node ${argv.join(' ')}`);
    const p = spawn(process.execPath, argv, { cwd: this.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    this.state = 'starting';
    p.stdout.setEncoding('utf8').on('data', (d) => this.append(d));
    p.stderr.setEncoding('utf8').on('data', (d) => this.append(d));
    p.on('error', (e) => this.append(`[spawn error] ${e.message}`));
    p.on('exit', (code, signal) => {
      this.append(`[exited ${signal || code}]`);
      this.exitInfo = this.state === 'stopping' ? null : (signal || code); // only report unexpected exits
      if (this.proc === p) { this.proc = null; this.state = 'stopped'; this.owner = null; }
    });
    const deadline = Date.now() + this.readyMs;
    while (this.proc === p && Date.now() < deadline) {
      if (await portOpen(this.port)) { this.state = 'running'; return; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (this.proc === p && this.state === 'starting') this.state = 'running'; // slow, but alive
  }

  stop() {
    const p = this.proc;
    if (!p) return Promise.resolve();
    this.state = 'stopping';
    return new Promise((resolve) => {
      const t = setTimeout(() => p.kill('SIGKILL'), 3000);
      p.once('exit', () => { clearTimeout(t); resolve(); });
      p.kill('SIGTERM');
    });
  }
}

export function createServices(root) {
  const minisrvDir = join(root, 'services', 'minisrv');
  const services = {
    minisrv: new Service('minisrv', { cwd: minisrvDir, args: () => ['app.js'], port: 1615, ready: 60000 }),
    relay: new Service('relay', {
      cwd: root,
      args: (o) => ['tools/relay.mjs', ...(o.mode === 'direct' ? [] : ['--target', '127.0.0.1'])],
      port: 8081,
    }),
  };
  services.minisrv.available = existsSync(join(minisrvDir, 'app.js'));

  const stopAll = () => Promise.all(Object.values(services).map((s) => s.stop()));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stopAll().then(() => process.exit(0)));
  process.on('exit', () => { for (const s of Object.values(services)) if (s.proc) s.proc.kill('SIGKILL'); });
  return { services, leases: new Leases(services) };
}

// Tracks which windows are still open (by their lease streams).
class Leases {
  constructor(services) {
    this.services = services;
    this.owners = new Map(); // id -> { streams: number, timer }
  }
  entry(id) {
    let e = this.owners.get(id);
    if (!e) { e = { streams: 0, timer: 0 }; this.owners.set(id, e); }
    return e;
  }
  open(id) {
    const e = this.entry(id);
    e.streams++;
    clearTimeout(e.timer); e.timer = 0; e.deadline = 0;
  }
  // ms until this owner's services are stopped, or 0 if its window is still open
  stopsIn(id) {
    const e = id && this.owners.get(id);
    return e && e.timer ? Math.max(0, e.deadline - Date.now()) : 0;
  }
  // another window takes over services whose window has closed
  adopt(newId) {
    let n = 0;
    for (const s of Object.values(this.services)) {
      if (s.proc && s.owner && s.owner !== newId && this.stopsIn(s.owner)) { s.owner = newId; n++; }
    }
    if (n) this.claimed(newId);
    return n;
  }
  close(id) {
    const e = this.entry(id);
    if (--e.streams <= 0) this.expireLater(id);
  }
  // called when a window starts a service: if it has no stream yet, the clock starts now
  claimed(id) {
    if (this.entry(id).streams <= 0) this.expireLater(id);
  }
  expireLater(id) {
    const e = this.entry(id);
    clearTimeout(e.timer);
    e.deadline = Date.now() + LEASE_GRACE_MS;
    e.timer = setTimeout(() => {
      this.owners.delete(id);
      for (const s of Object.values(this.services)) {
        if (s.proc && s.owner === id) {
          s.append('[window that started this service closed; stopping]');
          s.stop();
        }
      }
    }, LEASE_GRACE_MS);
  }
}

// GET /api/builds: boot ROMs and OS builds found in data/rom-collection (any
// .../bootrom/<flavor>/build-N/_bootstraprom.o and .../approm/<flavor>/build-N/_approm.o), as
// URLs the page can fetch from this server. OS builds that ship symbols.sym carry its URL as
// `symbols` (needed to patch them for the LPT modem bridge).
export function handleBuildsApi(root, req, res, url) {
  if (url.pathname !== '/api/builds') return false;
  const out = { bootroms: [], os: [] };
  const base = join(root, 'data', 'rom-collection');
  const walk = (dir, depth) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 8) walk(p, depth + 1); continue; }
      const m = /([^/]+)\/(bootrom|approm)\/([^/]+)\/build-(\d+)\/(_bootstraprom|_approm)\.o$/.exec(p);
      if (!m || (m[2] === 'bootrom') !== (m[5] === '_bootstraprom')) continue;
      const rel = p.slice(root.length + 1).split('/').map(encodeURIComponent).join('/');
      const item = { box: m[1], flavor: m[3], build: Number(m[4]), size: st.size, url: '/' + rel };
      // OS builds with a symbol table can be patched for the LPT modem bridge
      if (m[2] === 'approm' && existsSync(join(dir, 'symbols.sym'))) item.symbols = item.url.replace(/_approm\.o$/, 'symbols.sym');
      (m[2] === 'bootrom' ? out.bootroms : out.os).push(item);
    }
  };
  walk(base, 0);
  const order = (a, b) => a.flavor.localeCompare(b.flavor) || b.build - a.build;
  out.bootroms.sort(order); out.os.sort(order);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(out));
  return true;
}

// POST /api/fetch: fetch a web page for the emulated box's built-in service (the box's http/https
// proxy). Body JSON {url, method, headers, body (base64)}; the reply is the page itself with its
// status in X-Fetch-Status and the final URL in X-Fetch-Url. Same checks as the service API.
export async function handleFetchApi(req, res, url) {
  if (url.pathname !== '/api/fetch') return false;
  const remote = req.socket.remoteAddress || '';
  const origin = req.headers.origin;
  if (!/^(127\.|::1$|::ffff:127\.)/.test(remote) || req.method !== 'POST' || req.headers['x-webtv-emu'] !== '1' ||
      (origin && origin !== 'null' && new URL(origin).host !== req.headers.host)) {
    res.writeHead(403).end();
    return true;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    const q = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!/^https?:\/\//i.test(q.url)) throw new Error('only http and https');
    const r = await fetch(q.url, {
      method: q.method || 'GET',
      headers: { 'User-Agent': 'Mozilla/3.0 WebTV/1.2 (compatible; MSIE 2.0)', ...(q.headers || {}) },
      body: q.body ? Buffer.from(q.body, 'base64') : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    const body = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
      'X-Fetch-Status': `${r.status} ${r.statusText || ''}`.trim(),
      'X-Fetch-Url': r.url,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain' }).end(String(e.message || e));
  }
  return true;
}

// Handles /api/services/... requests. Returns false if the path is not an API path.
export async function handleServicesApi({ services, leases }, req, res, url) {
  if (!url.pathname.startsWith('/api/services')) return false;
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  // These endpoints start processes: only answer local, same-origin requests. The custom
  // header makes cross-site requests need a CORS preflight, which this server never grants.
  const remote = req.socket.remoteAddress || '';
  if (!/^(127\.|::1$|::ffff:127\.)/.test(remote)) return json(403, { error: 'local requests only' }), true;
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (req.headers['x-webtv-emu'] !== '1' || (origin && new URL(origin).host !== req.headers.host)) {
      return json(403, { error: 'forbidden' }), true;
    }
  }

  const validId = (id) => typeof id === 'string' && /^[\w-]{8,64}$/.test(id);
  const parts = url.pathname.split('/').filter(Boolean); // api services [name] [action]
  if (parts.length === 2 && req.method === 'GET') {
    const me = url.searchParams.get('owner');
    const out = {};
    for (const [k, s] of Object.entries(services)) {
      out[k] = {
        ...(await s.status()), available: s.available !== false,
        owned: s.owner ? (s.owner === me ? 'mine' : 'other') : null,
        stopsIn: s.proc ? leases.stopsIn(s.owner) : 0, // its window closed; stopping soon
      };
    }
    return json(200, out), true;
  }
  if (parts[2] === 'lease' && req.method === 'GET') {
    const id = url.searchParams.get('owner');
    if (!validId(id)) return json(400, { error: 'bad owner id' }), true;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write(': lease\n\n');
    leases.open(id);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); leases.close(id); });
    return true;
  }
  if (parts[2] === 'adopt' && req.method === 'POST') {
    const id = req.headers['x-webtv-owner'];
    if (!validId(id)) return json(400, { error: 'bad owner id' }), true;
    return json(200, { adopted: leases.adopt(id) }), true;
  }
  const svc = services[parts[2]];
  if (!svc) return json(404, { error: 'no such service' }), true;
  const action = parts[3];
  try {
    if (action === 'log' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      return json(200, { lines: svc.log.filter(([n]) => n > since), seq: svc.seq }), true;
    }
    if (action === 'start' && req.method === 'POST') {
      if (svc.available === false) throw new Error(`${svc.name} is not installed (services/minisrv missing)`);
      const owner = req.headers['x-webtv-owner'];
      const id = validId(owner) ? owner : null;
      await svc.start(Object.fromEntries(url.searchParams), id);
      if (id) leases.claimed(id);
      return json(200, await svc.status()), true;
    }
    if (action === 'stop' && req.method === 'POST') {
      await svc.stop();
      return json(200, await svc.status()), true;
    }
  } catch (e) {
    return json(409, { error: e.message }), true;
  }
  return json(404, { error: 'unknown action' }), true;
}
