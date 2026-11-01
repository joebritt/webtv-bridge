// Persistent box state in IndexedDB, shared by the page and the emulator worker.
//
//   sectors  key [diskId, lba] -> Uint8Array(512)   sectors the box wrote to its disk
//   kv       key 'nvram'       -> Uint8Array        24C01 NVRAM contents
//
// diskId names the disk image (its URL path, or file name + size) so writes made on one
// image are never applied to another.

const DB_NAME = 'webtv-emulator';

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('sectors')) d.createObjectStore('sectors');
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
});

export async function loadSectors(diskId) {
  const d = await db();
  const tx = d.transaction('sectors', 'readonly');
  const out = new Map();
  const range = IDBKeyRange.bound([diskId, 0], [diskId, Infinity]);
  await new Promise((resolve, reject) => {
    const req = tx.objectStore('sectors').openCursor(range);
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { resolve(); return; }
      out.set(c.key[1], new Uint8Array(c.value));
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return out;
}

export async function saveSectors(diskId, entries) {
  const d = await db();
  const tx = d.transaction('sectors', 'readwrite');
  const st = tx.objectStore('sectors');
  for (const [lba, data] of entries) st.put(data, [diskId, lba]);
  return done(tx);
}

export async function getKV(key) {
  const d = await db();
  const tx = d.transaction('kv', 'readonly');
  const req = tx.objectStore('kv').get(key);
  await done(tx);
  return req.result;
}

export async function setKV(key, value) {
  const d = await db();
  const tx = d.transaction('kv', 'readwrite');
  tx.objectStore('kv').put(value, key);
  return done(tx);
}

// Count of saved sectors per disk, for the UI.
export async function stateSummary() {
  const d = await db();
  const tx = d.transaction(['sectors', 'kv'], 'readonly');
  const sectors = tx.objectStore('sectors').count();
  const nv = tx.objectStore('kv').get('nvram');
  await done(tx);
  return { sectors: sectors.result, nvram: !!nv.result };
}

// Forget everything: the next boot is a factory-fresh box.
export async function clearState() {
  const d = await db();
  const tx = d.transaction(['sectors', 'kv'], 'readwrite');
  tx.objectStore('sectors').clear();
  tx.objectStore('kv').clear();
  return done(tx);
}
