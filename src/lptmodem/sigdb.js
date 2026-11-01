// The signature database that ships with the patcher (sigdb.json, written by
// tools/lptsigs.mjs build), for builds without symbols.sym. Node only; the page fetches the
// JSON itself and calls sigs.js.
import { readFileSync } from 'node:fs';
import { unpackDb, recoverSymbols } from './sigs.js';
import { osImageInfo } from '../machine/osinstall.js';

let db = null;
export function signatureDb() {
  if (!db) db = unpackDb(JSON.parse(readFileSync(new URL('./sigdb.json', import.meta.url), 'utf8')));
  return db;
}

// a symbol source for patch.js, recovered from the image's code
export function symbolsFromSignatures(img) {
  const u8 = img instanceof Uint8Array ? img : new Uint8Array(img);
  return recoverSymbols(u8, osImageInfo(u8), signatureDb());
}
