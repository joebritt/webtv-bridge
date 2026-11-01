// In-page WebTV service: enough of a WebTV service to boot the box through registration and
// login to a home page, with no server. Protocol and header sets follow zefie's minisrv (the
// wtv-1800, wtv-head-waiter, wtv-register, wtv-setup and wtv-home service scripts); the pages
// themselves are our own.
//
//   const svc = new WebTVService({ store, log });
//   transport.openTcp('10.0.0.1', port, handlers) -> svc.openConnection(port, io)

import { WTVSec, DEFAULT_INITIAL_KEY } from './wtvsec.js';
import { WtvpConnection } from './wtvp.js';
import { b64encode, fromLatin1 } from './crypto.js';
import * as pages from './pages.js';

const HOST = '10.0.0.1';
// name -> [port, flags, connections], as minisrv announces them
const SERVICES = {
  'wtv-1800': [1615, '0x00000001', 1],
  'wtv-head-waiter': [1601, null, 1],
  'wtv-star': [1603, '0x00000007', null],
  'wtv-register': [1607, null, null],
  'wtv-flashrom': [1618, '0x00000040', null],
  'wtv-log': [1609, null, 1],
  'wtv-home': [1612, null, null],
  'wtv-setup': [1613, '0x00000010', 3],
  'wtv-mail': [1608, null, 3],
  'wtv-favorite': [1611, null, 3],
  'wtv-cookie': [1619, null, 1],
  'wtv-tricks': [1602, '0x00000004', null],
  http: [1650, '0x00000001', 3],
  https: [1650, '0x00000001', 3],
};
// the TCP ports the service is reached on (for serving it on real sockets)
export const SERVICE_PORTS = [...new Set(Object.values(SERVICES).map((v) => v[0]))].sort();
function serviceString(name) {
  const [port, flags, conns] = SERVICES[name];
  const one = (n) => `wtv-service: name=${n} host=${HOST} port=${port}${flags ? ` flags=${flags}` : ''}${conns ? ` connections=${conns}` : ''}`;
  return name === 'wtv-star' ? `${one(name)}\n${one('wtv-*')}` : one(name);
}
const allServices = (except = []) => Object.keys(SERVICES).filter((n) => !except.includes(n)).sort().map(serviceString).join('\n');

const httpDate = (d = new Date()) => d.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1, $2 $3 $4 $5 GMT');

function parseQuery(s) {
  const q = {};
  if (!s) return q;
  for (const part of s.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const dec = (x) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
    if (i < 0) q[dec(part)] = ''; else q[dec(part.slice(0, i))] = dec(part.slice(i + 1));
  }
  return q;
}

// Default in-memory store; the emulator passes one backed by IndexedDB.
export class MemoryStore {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.get(k) ?? null; }
  async set(k, v) { this.m.set(k, v); }
}

class Session {
  constructor(ssid, data) {
    this.ssid = ssid;
    this.data = data || { registered: false };
    this.login = null; // WTVSec for the login handshake / ticket
  }
}

export class WebTVService {
  // account: data for boxes the store doesn't know (e.g. { registered: true, subscriber_name: 'Test' }
  // to skip registration); visit: a URL the home page sends the box to (testing);
  // openIspScript: a packed OpenISP TellyScript for boxes set to use their own ISP (wtv-open-access);
  // now: () => Date, the time the service tells boxes (wtv-client-date). Tests pin it: the OS
  // schedules its late-night reboot from it, and near that hour a box restarting reboots at once.
  constructor({ store = new MemoryStore(), log = () => {}, name = 'WebTV Emulator', initialKey = DEFAULT_INITIAL_KEY, fetchUrl = null, account = null, visit = null, openIspScript = null, now = () => new Date() } = {}) {
    this.now = now;
    this.store = store;
    this.log = log;
    this.name = name;
    this.initialKey = initialKey;
    this.fetchUrl = fetchUrl; // optional (url, {method, headers, body}) -> Promise<{status, headers, body}> for http(s)
    this.sessions = new Map();
    this.account = account;
    this.visit = visit;
    this.openIspScript = openIspScript;
  }

  // the transport side: one TCP connection to 10.0.0.1:port
  openConnection(port, io) {
    return new WtvpConnection(this, io, { log: this.log, port });
  }

  async session(ssid) {
    let s = this.sessions.get(ssid);
    if (!s) {
      s = new Session(ssid, (await this.store.get(`account:${ssid}`)) || (this.account && { ...this.account }));
      this.sessions.set(ssid, s);
    }
    return s;
  }

  save(s) { return this.store.set(`account:${s.ssid}`, s.data); }

  // WTVSec for a connection that just sent SECURE ON
  connectionSecurity(h) {
    const sec = new WTVSec(this.initialKey, Number(h['wtv-incarnation']) || 1);
    if (h['wtv-ticket']) sec.decodeTicket(h['wtv-ticket']);
    sec.secureOn();
    return sec;
  }

  // headers added to every response on a connection (a freshly issued ticket)
  extraHeaders(conn) {
    const s = conn.session;
    if (s && s.login && s.login.updateTicket && s.login.ticketB64) {
      s.login.updateTicket = false;
      return [['wtv-ticket', s.login.ticketB64]];
    }
    return [];
  }

  async handle(req, conn) {
    const h = req.headers;
    const m = /^([\w*.+-]+):\/?\/?([^?]*)(?:\?(.*))?$/.exec(req.url);
    if (!m) return this.notFound(req);
    const [, service, path, qs] = m;
    const query = parseQuery(qs);
    if (req.method === 'POST' && req.body.length) Object.assign(query, parseQuery(fromLatin1(req.body)));
    // the box only sends its serial on some requests: remember it per connection (as minisrv
    // does per socket), else use the last box we saw
    const ssid = h['wtv-client-serial-number'] || conn.ssid || this.lastSsid;
    if (ssid) { conn.ssid = ssid; this.lastSsid = ssid; }
    const s = ssid ? await this.session(ssid) : null;
    if (!s && !(service === 'http' || service === 'https')) return { head: '400 Please reconnect\nContent-Type: text/html', body: '' };
    conn.session = s;
    const ctx = { req, h, query, s, conn, service, path };
    this.log(`[wtvsrv] ${req.method} ${req.url}${req.secure ? ' (secure)' : ''}`);
    if (service === 'http' || service === 'https') return this.proxy(ctx);
    const handler = this.routes[`${service}:/${path}`];
    if (handler) return handler.call(this, ctx);
    return this.notFound(req);
  }

  notFound(req) {
    return { head: '404 The page you requested is not available on this service\nContent-Type: text/html', body: pages.message('Not available', `${req.url} isn't on this service.`) };
  }

  // ---------------------------------------------------------------- web pages via the host

  async proxy({ req, h }) {
    if (!this.fetchUrl) return { head: '400 Web browsing isn\'t available here\nContent-Type: text/html', body: '' };
    try {
      const r = await this.fetchUrl(req.url, { method: req.method, headers: { 'Content-Type': h['content-type'] }, body: req.method === 'POST' ? req.body : undefined });
      const type = (r.headers['content-type'] || 'text/html').split(';')[0];
      const status = /^\d{3}/.test(r.status || '') ? r.status : '200 OK';
      return { head: `${status}\nwtv-http-proxy: true\nContent-Type: ${type}`, body: r.body };
    } catch (e) {
      return { head: `400 Couldn't reach that page (${e.message})\nContent-Type: text/html`, body: '' };
    }
  }
}

// ---------------------------------------------------------------- handlers

const R = WebTVService.prototype.routes = {};

R['wtv-1800:/preregister'] = async function ({ h, query, s }) {
  s.login = new WTVSec(this.initialKey);
  s.login.issueChallenge();
  if (h['wtv-incarnation']) s.login.setIncarnation(h['wtv-incarnation']);
  let gourl = 'wtv-head-waiter:/login?';
  if (query.relogin && s.data.registered) gourl += 'relogin=true';
  if (query.reconnect && s.data.registered) gourl += 'reconnect=true';
  if (h['wtv-ticket'] && !query.reconnect) gourl = 'wtv-head-waiter:/login-stage-two?relogin=true';
  if (query.reconnect) gourl = null;
  // A box set to use its own ISP wants the OpenISP TellyScript (it dials that ISP and logs in
  // with the ISP username and password); send it unless the box already runs it.
  const openAccess = h['wtv-open-access'] === 'true';
  let script = null;
  if (openAccess && this.openIspScript && !query.reconnect) {
    const b = this.openIspScript;
    const id = ((b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15]) >>> 0;
    if ((Number(h['wtv-script-id']) >>> 0) !== id) script = b;
    this.log(`[wtv] box uses its own ISP (script id ${h['wtv-script-id'] || 'none'})${script ? '; sending the OpenISP TellyScript' : ''}`);
  }
  let head = `200 OK
Connection: Keep-Alive
wtv-initial-key: ${b64encode(s.login.challengeKey)}
Content-Type: ${script ? 'text/tellyscript' : 'text/html'}
`;
  if (!query.reconnect) head += 'wtv-service: reset\n';
  head += [serviceString('wtv-1800'), serviceString('wtv-head-waiter'), serviceString('wtv-star')].join('\n') + '\n';
  if (query.reconnect && !s.data.registered) head += serviceString('wtv-register') + '\n';
  head += serviceString('wtv-flashrom') + '\n';
  head += 'wtv-boot-url: wtv-head-waiter:/login?relogin=true\n';
  if (gourl) head += `wtv-visit: ${gourl}\n`;
  if (openAccess) head += 'wtv-open-isp-disabled: false\n';
  head += `wtv-client-time-zone: GMT -0000
wtv-client-time-dst-rule: GMT
wtv-client-date: ${httpDate(this.now())}`;
  return { head, body: script || '' };
};

R['wtv-head-waiter:/login'] = async function ({ h, query, s }) {
  if (!s.login) {
    // no preregister yet this session, so the box doesn't have our key: start over there
    return {
      head: `200 OK
Connection: Keep-Alive
Expires: Wed, 09 Oct 1991 22:00:00 GMT
wtv-expire-all: wtv-head-waiter:
wtv-expire-all: wtv-1800:
wtv-visit: wtv-head-waiter:/relogin?relogin=true
Content-type: text/html`,
      body: '',
    };
  }
  let challenge = '';
  if (h['wtv-ticket']) {
    if (!s.login.ticketB64 && h['wtv-ticket'].length > 8) {
      try { s.login.decodeTicket(h['wtv-ticket']); } catch (e) { this.log(`[wtvsrv] ${e.message}`); challenge = s.login.issueChallenge(); }
    }
  } else {
    challenge = s.login.issueChallenge();
  }
  const gourl = 'wtv-head-waiter:/ValidateLogin?' + (query.relogin ? 'relogin=true' : query.reconnect ? 'reconnect=true' : 'initial_login=true');
  return {
    head: `200 OK
Connection: Keep-Alive
Expires: Wed, 09 Oct 1991 22:00:00 GMT
wtv-expire-all: wtv-head-waiter:
${serviceString('wtv-log')}
wtv-log-url: wtv-log:/log${challenge ? `\nwtv-challenge: ${challenge}` : ''}
wtv-country: US
wtv-language-header: en-US,en
wtv-relogin-url: wtv-head-waiter:/relogin?relogin=true
wtv-reconnect-url: wtv-head-waiter:/relogin?reconnect=true
wtv-visit: ${gourl}
Content-type: text/html`,
    body: '',
  };
};

R['wtv-head-waiter:/ValidateLogin'] = async function ({ h, s }) {
  if (!s.login) return { head: '500 Please reconnect\nwtv-visit: wtv-head-waiter:/relogin?relogin=true\nContent-Type: text/html', body: '' };
  const resp = h['wtv-challenge-response'];
  if (!s.login.ticketB64) {
    if (!s.login.checkResponse(resp)) {
      this.log('[wtvsrv] wtv-challenge-response did not match');
      return { head: '500 Invalid challenge response received\nContent-Type: text/html', body: '' };
    }
    s.login.ticketStore = { user_id: 0 };
    s.login.prepareTicket();
  }
  let head = `200 OK
Content-Type: text/html
wtv-connection-close: true
Connection: close`;
  if (resp) head += '\nwtv-encrypted: true';
  head += '\nwtv-visit: wtv-head-waiter:/login-stage-two?';
  return { head, body: '' };
};

R['wtv-head-waiter:/relogin'] = async function ({ query }) {
  const gourl = 'wtv-1800:/preregister?' + (query.relogin ? 'relogin=true' : query.reconnect ? 'reconnect=true' : '');
  return {
    head: `200 OK
Connection: Keep-Alive
Expires: Wed, 09 Oct 1991 22:00:00 GMT
wtv-expire-all: wtv-head-waiter:
wtv-expire-all: wtv-1800:
wtv-service: reset
${serviceString('wtv-1800')}
wtv-visit: ${gourl}
Content-type: text/html`,
    body: '',
  };
};

R['wtv-head-waiter:/login-stage-two'] = async function ({ query, s }) {
  if (!s.data.registered) {
    return {
      head: `200 OK
wtv-open-isp-disabled: false
wtv-encrypted: true
${serviceString('wtv-register')}
${serviceString('wtv-head-waiter')}
${serviceString('wtv-star')}
wtv-boot-url: wtv-head-waiter:/relogin?
wtv-visit: wtv-register:/splash?
Content-type: text/html`,
      body: '',
    };
  }
  const d = s.data;
  if (!d.userid) { d.userid = '1' + String(Math.floor(Math.random() * 1e15)).padStart(15, '0'); await this.save(s); }
  let head = `200 OK
Connection: Keep-Alive
wtv-expire-all: wtv-head-waiter:
wtv-country: US
wtv-client-time-zone: GMT -0000
wtv-client-time-dst-rule: GMT
wtv-client-date: ${httpDate(this.now())}
wtv-language-header: en-US,en
wtv-noback-all: wtv-
wtv-transition-override: off
wtv-smartcard-inserted-message: Contacting service
wtv-ssl-timeout: 240
wtv-login-timeout: 7200
wtv-service: reset
${allServices(['wtv-register'])}
wtv-log-url: wtv-log:/log
wtv-ssl-log-url: wtv-log:/log
wtv-bypass-proxy: false
user-id: ${d.userid}
wtv-human-name: ${d.subscriber_name || d.subscriber_username}
wtv-input-timeout: 14400
wtv-connection-timeout: 1440
wtv-fader-timeout: 1440
wtv-inactive-timeout: 1440
wtv-relogin-url: wtv-head-waiter:/relogin?relogin=true
wtv-reconnect-url: wtv-head-waiter:/login-stage-two?reconnect=true
wtv-boot-url: wtv-head-waiter:/relogin?relogin=true
wtv-home-url: wtv-home:/home?`;
  if (!query.reconnect) head += '\nwtv-settings-url: wtv-setup:/get';
  head += `
wtv-show-time-enabled: true
wtv-allow-dsc: true
wtv-tourist-enabled: false
wtv-offline-mail-enable: false
wtv-demo-mode: 0
wtv-name-server: 10.0.0.1
wtv-open-isp-disabled: false`;
  if (!query.reconnect) head += '\nwtv-visit: wtv-home:/splash?';
  head += '\nContent-Type: text/html';
  return { head, body: '' };
};

// ---- registration

R['wtv-register:/splash'] = async function () {
  return { head: '200 OK\nConnection: Keep-Alive\nwtv-expire-all: wtv-\nwtv-expire-all: http\nContent-Type: text/html', body: pages.splash(this.name, 'wtv-register:/register?') };
};

R['wtv-register:/register'] = async function ({ query }) {
  return { head: '200 OK\nContent-Type: text/html', body: pages.register(this.name, query) };
};

R['wtv-register:/ValidateAccountInfo'] = async function ({ query, s }) {
  const name = (query.subscriber_name || '').trim(), user = (query.subscriber_username || '').trim();
  let err = null;
  if (!name) err = 'Please enter your name.';
  else if (!/^[A-Za-z][A-Za-z0-9_-]{1,15}$/.test(user)) err = 'Please choose a username of 2 to 16 letters, numbers, _ or -, starting with a letter.';
  if (err) return { head: '200 OK\nContent-Type: text/html', body: pages.register(this.name, query, err) };
  Object.assign(s.data, { subscriber_name: name, subscriber_username: user, registered: true, registered_at: Date.now() });
  await this.save(s);
  return { head: '200 OK\nwtv-noback-all: wtv-register:\nContent-Type: text/html', body: pages.registered(this.name, name, user) };
};

R['wtv-register:/FinishRegistration'] = async function ({ s }) {
  if (!s.login) s.login = new WTVSec(this.initialKey);
  if (!s.login.challengeRaw) s.login.issueChallenge();
  s.login.ticketStore = { user_id: 0 };
  s.login.prepareTicket();
  s.login.updateTicket = false; // sent explicitly below
  return {
    head: `300 Moved
Connection: Close
wtv-noback-all: wtv-register:
wtv-expire-all: wtv-
wtv-ticket: ${s.login.ticketB64}
wtv-service: reset
${serviceString('wtv-1800')}
${serviceString('wtv-head-waiter')}
${serviceString('wtv-star')}
wtv-relogin-url: wtv-1800:/preregister?relogin=true
wtv-reconnect-url: wtv-1800:/preregister?reconnect=true
wtv-boot-url: wtv-1800:/preregister?relogin=true
Location: client:relogin`,
    body: '',
  };
};

// ---- after login

R['wtv-setup:/get'] = async function ({ s }) {
  const settings = {
    'from-server': 1, 'setup-advanced-options': 0, 'setup-play-bgm': 0, 'setup-bgm-tempo': -1, 'setup-bgm-volume': 100,
    'setup-background-color': 'c6c6c6', 'setup-font-sizes': 'medium', 'setup-in-stereo': 1, 'setup-keyboard': 'alphabetical',
    'setup-link-color': '2222bb', 'setup-play-songs': 1, 'setup-play-sounds': 1, 'setup-text-color': 0, 'setup-visited-color': '8822bb',
    ...(s.data.settings || {}),
  };
  return {
    head: '200 OK\nwtv-printer-model: -1,-1\nwtv-printer-pen: 0,0,1,0\nwtv-printer-setup: 0,0,1,0\nwtv-language-header: en-US,en\nContent-Type: text/html',
    body: Object.entries(settings).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&'),
  };
};

R['wtv-home:/splash'] = async function () {
  return { head: '200 OK\nConnection: Keep-Alive\nwtv-expire-all: wtv-\nwtv-expire-all: http\nContent-Type: text/html', body: pages.splash(this.name, 'wtv-home:/home?') };
};

R['wtv-home:/home'] = async function ({ s }) {
  return { head: '200 OK\nContent-Type: text/html', body: pages.home(this.name, s.data, this.visit) };
};

R['wtv-log:/log'] = async function () { return { head: '200 OK\nContent-Type: text/html', body: '' }; };
R['wtv-mail:/addresslist'] = async function () { return { head: '200 OK\nContent-Type: x-wtv-addresses', body: '' }; };
R['wtv-favorite:/list-folders'] = async function () { return { head: '200 OK\nContent-Type: text/plain', body: '' }; };
R['wtv-cookie:/list'] = async function () { return { head: '200 OK\nContent-Type: text/plain', body: '' }; };
