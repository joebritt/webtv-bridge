// Disk browser dialog: partitions, FAT directories and files, and a sector viewer for the
// selected disk image, as the box sees it (saved box-state writes applied on top).

import { WebTVDisk, PART_TYPES } from './wtvdisk.js';
import { PackedDisk, isPackedDisk } from './packed-disk.js';
import { loadSectors } from './persist.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
};
const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fmtDate = (d) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
const hex2 = (b) => b.toString(16).padStart(2, '0');

function hexDump(bytes, base = 0) {
  const lines = [];
  for (let o = 0; o < bytes.length; o += 16) {
    const row = bytes.subarray(o, o + 16);
    lines.push(`${(base + o).toString(16).padStart(6, '0')}  ${[...row].map(hex2).join(' ').padEnd(47)}  ${[...row].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('')}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- disk sources

// Raw image over HTTP: 256 KB range requests, cached.
function urlReader(url) {
  const BLOCK = 256 * 1024, cache = new Map();
  let size = 0;
  const block = (b) => {
    let p = cache.get(b);
    if (!p) {
      p = fetch(url, { headers: { Range: `bytes=${b * BLOCK}-${b * BLOCK + BLOCK - 1}` } }).then(async (r) => {
        if (!size) size = Number((r.headers.get('Content-Range') || '').split('/')[1]) || 0;
        return new Uint8Array(await r.arrayBuffer());
      });
      cache.set(b, p);
      if (cache.size > 256) cache.delete(cache.keys().next().value);
    }
    return p;
  };
  return {
    async size() { await block(0); return size; },
    async read(lba, count) {
      const out = new Uint8Array(count * 512);
      let pos = lba * 512, o = 0;
      while (o < out.length) {
        const b = Math.floor(pos / BLOCK), off = pos - b * BLOCK;
        const d = await block(b);
        const n = Math.min(out.length - o, d.length - off);
        if (n <= 0) break;
        out.set(d.subarray(off, off + n), o);
        o += n; pos += n;
      }
      return out;
    },
  };
}

// src: what main.js resolved for the worker (File, { url }, { bytes }) -> { read(lba,count), size }
async function openSource(src) {
  if (src.bytes || (src.url && /\.wtvd(\?|$)/.test(src.url))) {
    const bytes = src.bytes || new Uint8Array(await (await fetch(src.url)).arrayBuffer());
    const pd = new PackedDisk(bytes);
    return { read: (l, n) => pd.read(l, n), size: pd.size };
  }
  if (src instanceof Blob) {
    const head = new Uint8Array(await src.slice(0, 8).arrayBuffer());
    if (isPackedDisk(head)) {
      const pd = new PackedDisk(new Uint8Array(await src.arrayBuffer()));
      return { read: (l, n) => pd.read(l, n), size: pd.size };
    }
    return { read: async (l, n) => new Uint8Array(await src.slice(l * 512, (l + n) * 512).arrayBuffer()), size: src.size };
  }
  const r = urlReader(src.url);
  return { read: (l, n) => r.read(l, n), size: await r.size() };
}

// ---------------------------------------------------------------- dialog

export function initDiskBrowser({ getSource }) {
  const dlg = $('disk-dlg');
  let disk = null, parts = [], cur = null; // cur: { part, fs, path: [entries] }

  async function load() {
    const body = $('disk-main'), nav = $('disk-parts');
    nav.replaceChildren(); body.replaceChildren(el('p', { className: 'hint', textContent: 'Reading disk…' }));
    try {
      const { src, diskId, label } = await getSource();
      if (!src) { body.replaceChildren(el('p', { className: 'hint', textContent: 'No disk image selected.' })); return; }
      const base = await openSource(src);
      let saved = new Map();
      try { if (diskId) saved = await loadSectors(diskId); } catch { /* no saved state */ }
      const readRaw = async (lba, n) => {
        const d = await base.read(lba, n);
        for (let i = 0; i < n; i++) { const s = saved.get(lba + i); if (s) d.set(s, i * 512); }
        return d;
      };
      disk = new WebTVDisk(readRaw, Math.floor(base.size / 512));
      $('disk-source').textContent = `${label} · ${fmtSize(base.size)}${saved.size ? ` · ${saved.size} sectors from saved box state` : ''}`;
      const t = await disk.partitions();
      parts = t.parts;
      nav.replaceChildren(...parts.map((p) => {
        const b = el('button', { className: 'disk-part' },
          el('b', { textContent: p.name || '(unnamed)' }),
          el('span', { textContent: `${PART_TYPES[p.type] || 'type ' + p.type} · ${fmtSize(p.size * 512)}` }));
        b.addEventListener('click', () => openPart(p));
        return b;
      }), el('button', { className: 'disk-part', onclick: () => showSectors(0) }, el('b', { textContent: 'Sectors' }), el('span', { textContent: 'raw hex viewer' })));
      if (!parts.length) { body.replaceChildren(el('p', { className: 'hint', textContent: 'No WebTV partition table found (looked at LBA 42504 and 34312).' })); return; }
      // open the first filesystem that has something in it
      let first = null;
      for (const p of parts.filter((q) => q.type === 2)) {
        const fs = await disk.openFat(p);
        if (fs && (await fs.list()).length) { first = p; break; }
      }
      first = first || parts.find((p) => p.type === 2) || parts[0];
      body.replaceChildren(el('p', { className: 'hint', textContent: `Partition table at LBA ${t.tableLba}. Pick a partition.` }));
      openPart(first);
    } catch (e) {
      body.replaceChildren(el('p', { className: 'hint err', textContent: `Could not read the disk: ${e.message}` }));
    }
  }

  function markPart(p) {
    [...$('disk-parts').children].forEach((b, i) => b.classList.toggle('sel', parts[i] === p));
  }

  async function openPart(p) {
    markPart(p);
    const body = $('disk-main');
    const info = el('p', { className: 'hint', textContent: `${p.name}: LBA ${p.start}–${p.start + p.size - 1} (${fmtSize(p.size * 512)}), type ${p.type} (${PART_TYPES[p.type] || '?'}), flags ${p.flags}` });
    if (p.type !== 2) {
      const extra = p.type === 3
        ? 'Boot partition: NV storage at LBA 1–14 (copy at 33796), OS build images (e.g. LBA 512 and 17411) and the partition table (LBA 42504). Use the sector viewer to look inside.'
        : 'Unallocated space.';
      body.replaceChildren(info, el('p', { className: 'hint', textContent: extra }),
        el('button', { textContent: `View sectors from LBA ${p.start}`, onclick: () => showSectors(p.start) }));
      return;
    }
    const fs = await disk.openFat(p);
    if (!fs) { body.replaceChildren(info, el('p', { className: 'hint', textContent: 'No FAT filesystem found in this partition.' })); return; }
    cur = { part: p, fs, path: [] };
    info.textContent += ` · ${fs.fat12 ? 'FAT12' : 'FAT16'} "${fs.label}", ${fs.clusters} clusters of ${fs.spc * 512 / 1024} KB`;
    cur.info = info;
    showDir();
  }

  async function showDir() {
    const { fs, path } = cur;
    const body = $('disk-main');
    const crumbs = el('div', { className: 'disk-crumbs' });
    const go = (n) => { cur.path = path.slice(0, n); showDir(); };
    crumbs.append(el('button', { className: 'link', textContent: cur.part.name, onclick: () => go(0) }));
    path.forEach((d, i) => crumbs.append(' / ', el('button', { className: 'link', textContent: d.name, onclick: () => go(i + 1) })));
    const entries = await fs.list(path[path.length - 1] || null);
    const rows = entries.map((e) => {
      const tr = el('tr', { className: e.isDir ? 'dir' : 'file', tabIndex: 0 },
        el('td', { textContent: (e.isDir ? '\u{1F4C1} ' : '') + e.name, title: e.name !== e.short ? `8.3 name: ${e.short}` : '' }),
        el('td', { className: 'num', textContent: e.isDir ? '' : fmtSize(e.size) }),
        el('td', { textContent: fmtDate(e.date) }));
      const open = () => { if (e.isDir) { cur.path = [...path, e]; showDir(); } else showFile(e, tr); };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (k) => { if (k.key === 'Enter') open(); });
      return tr;
    });
    const table = el('table', { className: 'disk-list' },
      el('thead', {}, el('tr', {}, el('th', { textContent: 'Name' }), el('th', { className: 'num', textContent: 'Size' }), el('th', { textContent: 'Modified' }))),
      el('tbody', {}, ...rows));
    body.replaceChildren(cur.info, crumbs, entries.length ? table : el('p', { className: 'hint', textContent: 'Empty folder.' }), el('div', { id: 'disk-file' }));
  }

  async function showFile(e, row) {
    document.querySelectorAll('.disk-list tr.sel').forEach((r) => r.classList.remove('sel'));
    row.classList.add('sel');
    const pane = $('disk-file');
    pane.replaceChildren(el('p', { className: 'hint', textContent: 'Reading…' }));
    const data = await cur.fs.readFile(e);
    const printable = data.length && [...data.subarray(0, 4096)].every((c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 160);
    const pre = el('pre', { className: 'disk-preview', textContent: printable ? new TextDecoder('latin1').decode(data.subarray(0, 65536)) : hexDump(data.subarray(0, 4096)) });
    const dl = el('button', {
      textContent: 'Download',
      onclick: () => {
        const a = el('a', { href: URL.createObjectURL(new Blob([data])), download: e.name });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      },
    });
    pane.replaceChildren(
      el('div', { className: 'row' }, el('b', { textContent: e.name }),
        el('span', { className: 'hint', textContent: `${fmtSize(e.size)} · first cluster ${e.cluster}${printable ? '' : ' · binary, first 4 KB shown'}` }), dl),
      pre);
  }

  async function showSectors(lba) {
    markPart(null);
    [...$('disk-parts').children].at(-1).classList.add('sel');
    const body = $('disk-main');
    const input = el('input', { type: 'number', min: 0, value: lba, className: 'lba' });
    const pre = el('pre', { className: 'disk-preview' });
    const show = async () => {
      const l = Math.max(0, Math.min(disk.sectorCount - 1, Number(input.value) | 0));
      input.value = l;
      pre.textContent = hexDump(await disk.read(l, 1), 0);
    };
    input.addEventListener('change', show);
    body.replaceChildren(
      el('p', { className: 'hint', textContent: 'One 512-byte sector in the CPU’s byte order (the image file has each 16-bit word swapped).' }),
      el('div', { className: 'row' }, 'LBA ', input,
        el('button', { textContent: '◀', onclick: () => { input.value = Number(input.value) - 1; show(); } }),
        el('button', { textContent: '▶', onclick: () => { input.value = Number(input.value) + 1; show(); } })),
      pre);
    show();
  }

  $('disk-open').addEventListener('click', () => { dlg.showModal(); load(); });
  $('disk-refresh').addEventListener('click', load);
  $('disk-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}
