// The Bridge's web page (pico/web/page.html). tools/webgen.mjs puts web/wtvdisk.js in front of
// this (WebTVDisk, FIXED_AREAS, PART_TYPES), then the whole page into the firmware, gzipped.
const $ = (i) => document.getElementById(i);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const two = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => d ? `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}` : '';
const stamp = (d = new Date()) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
const say = (id, text, bad) => { const e = $(id); e.textContent = text; e.classList.toggle('err', !!bad); };
function saveBlob(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------------------------------------------------------------- tabs

const TABS = [...document.querySelectorAll('#tabs button')].map((b) => b.dataset.tab);
function show(tab) {
  if (!TABS.includes(tab)) tab = 'console';
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const t of TABS) $(t).classList.toggle('on', t === tab);
  if (location.hash.slice(1) !== tab) history.replaceState(null, '', '#' + tab);
  if (tab === 'console') { const o = $('out'); o.scrollTop = o.scrollHeight; }
}
for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => show(b.dataset.tab);
window.onhashchange = () => show(location.hash.slice(1));
show(location.hash.slice(1));

// ---------------------------------------------------------------- what the box allows right now

const ready = { os: false, box: false, shot: false, keys: false };
let keysTo = 0;            // X-Keys: 1 the WebTV Bridge screen, 2 the running OS
let memFrom = 0;            // X-Mem: 1 the WebTV Bridge screen (the loader), 2 the running OS (PARMOD)
let busy = false;           // a Screenshot or Box Filesystem operation is running
const NOT_NOW = 'Not now: the TV isn\'t showing the WebTV Bridge screen. Restart the box (or switch it on); when that screen comes up, press any key on the remote to hold it there.';
function gate() {
  for (const e of document.querySelectorAll('.ready')) {
    const ok = ready[e.dataset.need];
    e.classList.toggle('ok', ok);
    if (e.dataset.need === 'shot') e.textContent = memFrom === 2 ? 'Ready: the box is running its OS; it reads its own screen for the Bridge.'
      : memFrom === 1 ? 'Ready: the WebTV Bridge screen is on the TV.'
      : 'Not now: the box is starting, or isn\'t running an OS the Bridge patched. Wait for the WebTV Bridge screen or for the OS.';
    else if (e.dataset.need === 'keys') e.textContent = keysTo === 1 ? 'Ready: keys go to the WebTV Bridge screen.'
      : keysTo === 2 ? 'Ready: keys go to the box\'s OS, into its IR input.'
      : 'Not now: the box isn\'t showing the WebTV Bridge screen or running an OS the Bridge patched to take keys (the 3xxx and 2046 builds don\'t).';
    else e.textContent = ok ? 'Ready: the WebTV Bridge screen is on the TV.' : NOT_NOW;
  }
  for (const e of document.querySelectorAll('button[data-need],input[data-need]')) e.disabled = !ready[e.dataset.need] || (busy && (e.dataset.need === 'box' || e.dataset.need === 'shot'));
  if (!ready.keys) { if ($('capture').checked) capture(false); if (monkeyTimer) monkey(false); }
}
async function work(msgId, fn) {
  if (busy) return;
  busy = true; gate();
  try { await fn(); } catch (e) { say(msgId, String(e.message || e).trim(), true); } finally { busy = false; gate(); }
}

// ---------------------------------------------------------------- Box & Bridge Info

async function info() {
  try {
    const t = await (await fetch('/info')).text(), d = $('grid');
    d.textContent = '';
    for (const l of t.split('\n')) {
      if (!l) continue;
      if (l[0] === '#') { d.append(el('h3', { textContent: l.slice(1) })); continue; }
      const [k, v] = l.split('\t');
      d.append(el('span', { className: 'k', textContent: k }), el('span', { textContent: v || '' }));
    }
  } catch (e) { }
}
async function st() {
  try {
    const r = await fetch('/status');
    $('st').textContent = await r.text();
    ready.os = r.headers.get('X-Ready') === '1';
    ready.box = r.headers.get('X-Box') === '1';
    memFrom = +(r.headers.get('X-Mem') || 0);
    ready.shot = memFrom > 0;
    keysTo = +(r.headers.get('X-Keys') || 0);
    ready.keys = keysTo > 0;
    gate();
  } catch (e) { }
}

// ---------------------------------------------------------------- Box Console

let next = 0;
async function con() {
  try {
    const r = await fetch('/console?from=' + next), t = await r.text(), o = $('out');
    next = +r.headers.get('X-Next');
    $('ses').textContent = r.headers.get('X-Session') === '1' ? 'The box is in its PARMOD session: what you type goes to its console.'
      : 'No PARMOD session: the box is not running its patched OS yet.';
    if (t) {
      const end = o.scrollTop + o.clientHeight >= o.scrollHeight - 8;
      o.textContent += t.replace(/\r/g, '');
      if (o.textContent.length > 60000) o.textContent = o.textContent.slice(-50000);
      if (end) o.scrollTop = o.scrollHeight;
    }
    if (t.length >= 4096) return con();
  } catch (e) { }
}
$('f').onsubmit = (e) => {
  e.preventDefault();
  const v = $('in').value;
  $('in').value = '';
  fetch('/console', { method: 'POST', body: v + '\r' }).then((r) => r.ok || r.text().then((m) => { $('ses').textContent = m; }));
};

// ---------------------------------------------------------------- Server Settings

function setting(path, input, form, msg) {
  fetch(path).then((r) => r.text()).then((t) => { t = t.trim(); $(input).value = t === 'auto' ? '' : t; });
  $(form).onsubmit = (e) => {
    e.preventDefault();
    fetch(path, { method: 'POST', body: $(input).value || (path === '/dns' ? 'auto' : '') })
      .then((r) => r.text().then((t) => { say(msg, t.trim(), !r.ok); info(); st(); }));
  };
}
setting('/service', 'svc', 'sv', 'svmsg');
setting('/dns', 'dns', 'd', 'dmsg');

// ---------------------------------------------------------------- Box OS

function up() {
  const f = $('file').files[0], m = $('msg');
  if (!f) return;
  const x = new XMLHttpRequest();
  x.open('POST', '/install');
  x.upload.onprogress = (e) => { m.textContent = 'sending ' + Math.round(100 * e.loaded / e.total) + '%'; };
  x.onload = () => { m.textContent = x.responseText; };
  x.onerror = () => { m.textContent = 'failed'; };
  x.send(f);
}

// ---------------------------------------------------------------- Screenshot

let shot = null;
async function fetchBytes(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.text()).trim());
  const total = +r.headers.get('Content-Length') || 0, rd = r.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (onProgress) onProgress(got, total);
  }
  if (total && got !== total) throw new Error(`the transfer stopped at ${fmtSize(got)} of ${fmtSize(total)}`);
  const out = new Uint8Array(got);
  let at = 0;
  for (const q of parts) { out.set(q, at); at += q.length; }
  return { bytes: out, headers: r.headers };
}
// box memory through the Bridge (/mem): through its loader, or read by the running OS
async function readMem(addr, len) {
  const r = await fetch(`/mem?addr=0x${(addr >>> 0).toString(16)}&len=${len}`);
  if (!r.ok) throw new Error((await r.text()).trim());
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length !== len) throw new Error('the box memory read came back short');
  return b;
}
$('grab').onclick = () => work('shmsg', async () => {
  const from = memFrom, t0 = performance.now();
  say('shmsg', 'reading the video registers...');
  // RAM through the loader as kseg1 (it runs uncached), through the OS as kseg0 (its own view)
  const g = await grabScreen(readMem, (phys) => (from === 1 ? 0xa0000000 : 0x80000000) + phys,
    (done, total) => say('shmsg', `reading the box's memory... ${fmtSize(done)}${total > done ? ' of ' + fmtSize(total) : ''}`));
  const cv = $('cv');
  cv.width = g.width; cv.height = g.height; cv.style.display = 'block';
  cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(g.rgba.buffer), g.width, g.height), 0, 0);
  shot = { ...g, when: new Date() };
  $('png').disabled = $('yuv').disabled = false;
  say('shmsg', `${g.width} x ${g.height}, ${g.mode === 'compositor' ? 'composited from the cels' : 'the framebuffer'}; ${fmtSize(g.bytesRead)} read`
    + `${from === 2 ? ' by the running OS' : ' through the loader'} in ${((performance.now() - t0) / 1000).toFixed(1)} s`
    + (g.mode === 'compositor' ? '. Its YUV file is converted from the picture.' : ''));
});
$('png').onclick = () => shot && $('cv').toBlob((b) => saveBlob(b, `webtv-screen-${stamp(shot.when)}.png`), 'image/png');
$('yuv').onclick = () => shot && saveBlob(new Blob([shot.yuyv]), `webtv-screen-${stamp(shot.when)}-${shot.width}x${shot.height}.yuyv`);

// ---------------------------------------------------------------- Box Filesystem

const MAX_PUT = 2048;       // sectors a write request (1 MB); the Bridge takes them 64 at a time
async function readRaw(lba, count) {
  const r = await fetch(`/disk?lba=${lba}&count=${count}`);
  if (!r.ok) throw new Error((await r.text()).trim());
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length !== count * 512) throw new Error('the disk read came back short');
  return b;
}
async function writeRaw(lba, bytes) {
  for (let at = 0; at < bytes.length; at += MAX_PUT * 512) {
    const part = bytes.subarray(at, Math.min(bytes.length, at + MAX_PUT * 512));
    const r = await fetch(`/disk?lba=${lba + at / 512}`, { method: 'PUT', body: part });
    if (!r.ok) throw new Error((await r.text()).trim());
  }
}
const disk = new WebTVDisk(readRaw, 0, { swapped: false, writeRaw });
const B = { part: null, fs: null, path: [] };    // the filesystem being browsed; path: folder entries

function act(label, fn) { return el('button', { className: 'small', textContent: label, onclick: fn }); }

async function downloadArea(name, start, size) {
  await work('fsmsg', async () => {
    const { bytes } = await fetchBytes(`/disk?lba=${start}&count=${size}`, (g, t) => say('fsmsg', `reading ${name}... ${Math.round(100 * g / t)}%`));
    saveBlob(new Blob([bytes]), `${name.replace(/[^\w.-]+/g, '-').replace(/-+$/, '')}-lba${start}.bin`);
    say('fsmsg', `${name}: ${fmtSize(bytes.length)} downloaded`);
  });
}

function replaceArea(name, start, size) {
  const pick = el('input', { type: 'file' });
  pick.onchange = () => work('fsmsg', async () => {
    const f = pick.files[0];
    if (!f) return;
    if (f.size > size * 512) throw new Error(`${f.name} is ${fmtSize(f.size)}; ${name} holds ${fmtSize(size * 512)}`);
    const n = Math.ceil(f.size / 512);
    if (!confirm(`Write ${f.name} (${fmtSize(f.size)}) onto the box's disk over ${name}, sectors ${start} to ${start + n - 1}?\n\nWhat is there now is lost.`)) return;
    const bytes = new Uint8Array(n * 512);
    bytes.set(new Uint8Array(await f.arrayBuffer()));
    for (let at = 0; at < n; at += MAX_PUT) {
      say('fsmsg', `writing ${name}... ${Math.round(100 * at / n)}%`);
      await writeRaw(start + at, bytes.subarray(at * 512, Math.min(n, at + MAX_PUT) * 512));
    }
    B.fs?.forget();
    say('fsmsg', `${name}: ${fmtSize(f.size)} written`);
  });
  pick.click();
}

function areaRow(name, type, start, size, sub, browse) {
  const acts = el('td', { className: 'act' });
  if (browse) acts.append(act('Browse', browse), ' ');
  acts.append(act('Download', () => downloadArea(name, start, size)));
  if (!browse) acts.append(' ', act('Replace...', () => replaceArea(name, start, size)));
  const tr = el('tr', {}, el('td', { textContent: name }), el('td', { textContent: type }),
    el('td', { className: 'num', textContent: String(start) }), el('td', { className: 'num', textContent: fmtSize(size * 512) }), acts);
  if (sub) tr.className = 'sub';
  return tr;
}

$('load').onclick = () => work('fsmsg', async () => {
  say('fsmsg', 'reading the partition table...');
  $('browser').hidden = true;
  const { tableLba, parts } = await disk.partitions();
  if (tableLba == null) throw new Error('no partition table on this disk (none at LBA 42504 or 34312)');
  const tb = el('tbody');
  for (const p of parts) {
    let browse = null;
    if (p.type === 2) browse = () => openFs(p);
    tb.append(areaRow(p.name, PART_TYPES[p.type] || `type ${p.type}`, p.start, p.size, false, browse));
    if (p.index === 0) for (const a of FIXED_AREAS) if (a.start + a.size <= p.start + p.size) tb.append(areaRow(a.name, 'fixed', a.start, a.size, true));
  }
  const t = el('table', { className: 'list' }, el('thead', {}, el('tr', {}, ...['Partition', 'Type', 'Start (LBA)', 'Size', ''].map((h, i) => el('th', { textContent: h, className: i === 2 || i === 3 ? 'num' : '' })))), tb);
  $('parts').replaceChildren(el('h2', { textContent: 'Partitions' }), t);
  say('fsmsg', `partition table at LBA ${tableLba}: ${parts.length} partitions`);
});

async function openFs(p) {
  await work('fsmsg', async () => {
    say('fsmsg', `opening ${p.name}...`);
    const fs = await disk.openFat(p);
    if (!fs) throw new Error(`no FAT filesystem in ${p.name}`);
    Object.assign(B, { part: p, fs, path: [] });
    await listing();
    $('browser').hidden = false;
    say('fsmsg', `${p.name}: FAT${fs.fat12 ? 12 : 16}, "${fs.label}", ${fmtSize(fs.clusterBytes)} clusters`);
  });
}

const here = () => B.path[B.path.length - 1] || null;

async function listing() {
  const { fs } = B;
  fs.forget();
  const items = await fs.list(here());
  $('where').textContent = `${B.part.name}:/` + B.path.map((e) => e.name).join('/');
  const tb = $('files').tBodies[0];
  tb.textContent = '';
  if (B.path.length) tb.append(el('tr', {}, el('td', {}, el('a', { textContent: '.. (up)', onclick: () => go(-1) })), el('td'), el('td'), el('td')));
  for (const e of items) {
    const name = el('a', { textContent: e.name + (e.isDir ? '/' : ''), title: e.short, onclick: () => (e.isDir ? go(e) : download(e)) });
    tb.append(el('tr', {}, el('td', {}, name), el('td', { className: 'num', textContent: e.isDir ? '' : fmtSize(e.size) }),
      el('td', { className: 'date', textContent: fmtDate(e.date) }), el('td', { className: 'act' }, act('Delete', () => del(e)))));
  }
  $('free').textContent = `${fmtSize((await fs.freeClusters()) * fs.clusterBytes)} free`;
}

function go(to) {
  work('fsmsg', async () => {
    if (to === -1) B.path.pop(); else B.path.push(to);
    await listing();
    say('fsmsg', '');
  });
}

function download(e) {
  work('fsmsg', async () => {
    say('fsmsg', `reading ${e.name}...`);
    saveBlob(new Blob([await B.fs.readFile(e)]), e.name);
    say('fsmsg', `${e.name}: ${fmtSize(e.size)} downloaded`);
  });
}

function del(e) {
  if (!confirm(`Delete ${e.name}${e.isDir ? ' (an empty folder)' : ''} from the box's disk?`)) return;
  work('fsmsg', async () => {
    await B.fs.remove(here(), e);
    await listing();
    say('fsmsg', `${e.name} deleted`);
  });
}

$('upbtn').onclick = () => $('upfile').click();
$('upfile').onchange = () => work('fsmsg', async () => {
  const files = [...$('upfile').files];
  $('upfile').value = '';
  const there = new Set((await B.fs.list(here())).map((e) => e.name.toLowerCase()));
  for (const f of files) {
    if (there.has(f.name.toLowerCase()) && !confirm(`Replace ${f.name} on the box's disk?`)) continue;
    const data = new Uint8Array(await f.arrayBuffer());
    await B.fs.writeFile(here(), f.name, data, (d, t) => say('fsmsg', `writing ${f.name}... ${Math.round(100 * d / t)}%`));
    say('fsmsg', `${f.name}: ${fmtSize(f.size)} written`);
  }
  await listing();
});
$('mkdir').onclick = () => {
  const name = prompt('Name of the new folder:');
  if (!name) return;
  work('fsmsg', async () => { await B.fs.mkdir(here(), name); await listing(); say('fsmsg', `${name}/ made`); });
};

// ---------------------------------------------------------------- polling

// ---------------------------------------------------------------- Remote
// Keys go to the Bridge as the first word of an entry in the OS's IR input ring (POST /key, in
// hex): the WebTV remote's 0, 0, 3, its code; the IR keyboard's 0x94 (pressed) or 0xd4 (let
// go), its scancode, 0, 0. web/irkeys.js has the codes (shared with the emulator).

const remoteKey = (name) => (0x0300 | REMOTE[name]) >>> 0;
const kbKey = (sc, up) => (((up ? 0xd4 : 0x94) << 24) | (sc << 16)) >>> 0;
let keyQueue = [], keySending = false, keysSent = 0;
async function sendKeys(list) {
  keyQueue.push(...list);
  if (keySending) return;
  keySending = true;
  while (keyQueue.length) {
    const batch = keyQueue.splice(0, 12);
    try {
      const r = await fetch('/key?e=' + batch.map((k) => k.toString(16).padStart(8, '0')).join(','), { method: 'POST' });
      const t = (await r.text()).trim();
      if (r.status === 503) { const n = parseInt(t) || 0; keysSent += n; keyQueue.unshift(...batch.slice(n)); await new Promise((f) => setTimeout(f, 150)); }
      else if (!r.ok) { say('keymsg', t, true); keyQueue = []; }
      else { keysSent += batch.length; say('keymsg', `${keysSent} keys sent.`); }
    } catch (e) { say('keymsg', 'The Bridge didn\'t answer.', true); keyQueue = []; }
  }
  keySending = false;
}
for (const b of document.querySelectorAll('#rc button[data-rc]')) b.onclick = () => sendKeys([remoteKey(b.dataset.rc)]);
for (const d of '1234567890') $('digits').append(el('button', { textContent: d, onclick: () => sendKeys([remoteKey(d)]) }));

// the IR keyboard: this computer's keys while capturing (no auto-repeat; held keys let go when it stops)
const held = new Set();
function onKey(e) {
  const sc = KEY_MAP[e.code];
  if (sc === undefined || e.target === $('capture')) return;
  e.preventDefault(); e.stopPropagation();
  if (e.type === 'keydown') { if (e.repeat || held.has(sc)) return; held.add(sc); sendKeys([kbKey(sc, false)]); }
  else if (held.delete(sc)) sendKeys([kbKey(sc, true)]);
}
function capture(on) {
  $('capture').checked = on;
  for (const t of ['keydown', 'keyup']) (on ? addEventListener : removeEventListener)(t, onKey, true);
  if (!on) { sendKeys([...held].map((sc) => kbKey(sc, true))); held.clear(); }
}
$('capture').onchange = () => capture($('capture').checked);
addEventListener('blur', () => { if ($('capture').checked) capture(false); });

// text, typed key by key (Shift where the character needs it)
const typeKeys = (s) => [...s].flatMap((ch) => {
  const [code, shift] = ch === '\n' ? ['Enter', false] : CHAR_KEYS[ch] || [];
  if (!code) return [];
  const sc = KEY_MAP[code], sh = KEY_MAP.ShiftLeft;
  return [...(shift ? [kbKey(sh, false)] : []), kbKey(sc, false), kbKey(sc, true), ...(shift ? [kbKey(sh, true)] : [])];
});
$('typef').onsubmit = (e) => { e.preventDefault(); const t = $('typetext').value; if (t) { sendKeys(typeKeys(t)); $('typetext').value = ''; } };

// the monkey: random presses until stopped
const NAV = ['up', 'down', 'left', 'right', 'select', 'select', 'back', 'scroll_up', 'scroll_down', 'home', 'recent'];   // not Options: its Print hangs a debug build (docs/bridge.md, Still open)
let monkeyTimer = 0, monkeyN = 0;
function monkey(on) {
  clearInterval(monkeyTimer); monkeyTimer = 0;
  $('monkey').textContent = on ? 'Stop' : 'Start';
  if (!on) return;
  monkeyN = 0;
  const ms = Math.max(50, +$('mms').value || 400);
  monkeyTimer = setInterval(() => {
    if (keyQueue.length > 24) return;          // the box is behind: wait
    const typing = $('mset').value === 'all' && Math.random() < 0.3;
    if (typing) sendKeys(typeKeys(String.fromCharCode(97 + Math.floor(Math.random() * 26))));
    else sendKeys([remoteKey(NAV[Math.floor(Math.random() * NAV.length)])]);
    say('mmsg', `${++monkeyN} presses`);
  }, ms);
}
$('monkey').onclick = () => monkey(!monkeyTimer);

info(); st(); con();
setInterval(info, 5000); setInterval(st, 2000); setInterval(con, 500);
