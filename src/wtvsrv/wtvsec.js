// WTVP security (challenge/response, tickets, RC4 session keys), ported from zefie's minisrv
// (includes/classes/WTVSec.js; protocol details credited there to eMac) for the in-page service.
//
// Challenge (base64): id[8] + DES-ECB(currentKey, secret), where secret is
//   echo[40] + sessionKey1[16] + sessionKey2[16] + newKey[8] + MD5(those 80 bytes)[16] + pad.
// minisrv's pad works out as 4 zero bytes (crypto-js parses "\x08..." as hex) and crypto-js
// then emits only 100 of the 104 encrypted bytes; the box accepts exactly that, so we do the same.
// Response: id[8] + DES-ECB(newKey, MD5(echo) + echo + 0x08 x 8).
// Ticket (base64): signingKey[8] + DES-ECB-PKCS7(initialKey, challenge[108] + JSON(store)).
// SECURE ON: RC4 key n = MD5(sessionKeyN + incarnation (u32 BE) + sessionKeyN); the box encrypts
// requests with key 1, the service encrypts response bodies with key 2.

import { md5, desEncrypt, desDecrypt, pkcs7Pad, pkcs7Unpad, RC4, concat, randomBytes, b64encode, b64decode } from './crypto.js';

export const DEFAULT_INITIAL_KEY = 'bWluaXNydiE='; // minisrv's default, so tickets interoperate

const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export class WTVSec {
  constructor(initialKeyB64 = DEFAULT_INITIAL_KEY, incarnation = 1) {
    this.initialKey = b64decode(initialKeyB64);
    if (this.initialKey.length !== 8) throw new Error('WTVSec: initial key must be 8 bytes');
    this.currentKey = this.initialKey;
    this.incarnation = Number(incarnation) || 1;
    this.challengeKey = null;       // key the box should use next (sent as wtv-initial-key)
    this.challengeSignedKey = null; // key the last issued challenge was encrypted with
    this.challengeRaw = null;
    this.challengeResponse = null;  // expected wtv-challenge-response (bytes)
    this.sessionKey1 = null;
    this.sessionKey2 = null;
    this.ticketB64 = null;
    this.ticketStore = {};
    this.updateTicket = false;
    this.rc4 = [];                  // 0 enc k1, 1 dec k1, 2 enc k2, 3 dec k2
  }

  setIncarnation(n) {
    n = Number(n);
    if (n && n !== this.incarnation) {
      this.incarnation = n;
      this.secureOn();
    }
  }

  issueChallenge() {
    const id = randomBytes(8);
    const puzzle = concat(randomBytes(40), randomBytes(16), randomBytes(16), randomBytes(8));
    const secret = concat(puzzle, md5(puzzle), new Uint8Array(8)); // 104 bytes, see above
    const enc = desEncrypt(secret, this.currentKey).subarray(0, 100);
    const challenge = concat(id, enc);
    this.challengeSignedKey = this.currentKey;
    this.challengeResponse = this.processChallenge(challenge);
    return b64encode(challenge);
  }

  // Decrypts a challenge with `key`, adopting its keys; returns the response the box sends.
  processChallenge(challenge, key = this.currentKey) {
    if (typeof challenge === 'string') challenge = b64decode(challenge);
    if (challenge.length <= 8) throw new Error('WTVSec: challenge too short');
    const id = challenge.subarray(0, 8);
    const dec = desDecrypt(challenge.subarray(8, 8 + 96), key);
    if (!eq(dec.subarray(80, 96), md5(dec.subarray(0, 80)))) return null; // wrong key
    this.currentKey = dec.slice(72, 80);
    this.sessionKey1 = dec.slice(40, 56);
    this.sessionKey2 = dec.slice(56, 72);
    const echo = dec.subarray(0, 40);
    const resp = desEncrypt(concat(md5(echo), echo, new Uint8Array(8).fill(8)), this.currentKey);
    this.challengeRaw = challenge.slice();
    this.challengeKey = this.currentKey;
    return concat(id, resp);
  }

  checkResponse(b64) {
    return !!(this.challengeResponse && b64 && b64encode(this.challengeResponse) === b64.trim());
  }

  prepareTicket() {
    const json = new TextEncoder().encode(JSON.stringify(this.ticketStore));
    const enc = desEncrypt(pkcs7Pad(concat(this.challengeRaw, json)), this.initialKey);
    this.ticketB64 = b64encode(concat(this.challengeSignedKey, enc));
    this.updateTicket = true;
    return this.ticketB64;
  }

  decodeTicket(b64) {
    const t = b64decode(b64);
    const key = t.subarray(0, 8);
    const dec = pkcs7Unpad(desDecrypt(t.subarray(8, 8 + ((t.length - 8) & ~7)), this.initialKey));
    const challenge = dec.subarray(0, 108);
    try { this.ticketStore = JSON.parse(new TextDecoder().decode(dec.subarray(108))) || {}; } catch { this.ticketStore = {}; }
    this.ticketB64 = b64;
    if (!this.processChallenge(challenge, key)) throw new Error('WTVSec: ticket does not decode with this service key');
  }

  secureOn() {
    const inc = new Uint8Array([this.incarnation >>> 24, this.incarnation >>> 16, this.incarnation >>> 8, this.incarnation].map((x) => x & 255));
    const k1 = md5(concat(this.sessionKey1, inc, this.sessionKey1));
    const k2 = md5(concat(this.sessionKey2, inc, this.sessionKey2));
    this.rc4 = [new RC4(k1), new RC4(k1), new RC4(k2), new RC4(k2)];
  }

  // the service encrypts with key 2 and decrypts the box's data with key 1
  encrypt(data) { if (!this.rc4[2]) this.secureOn(); return this.rc4[2].update(data); }
  decrypt(data) { if (!this.rc4[1]) this.secureOn(); return this.rc4[1].update(data); }
}
