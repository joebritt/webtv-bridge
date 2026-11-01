// The whole patch as the Node tools apply it: patchLptModem, with the names from the build's
// symbols.sym or, without one (symBytes null), from the code itself (sigs.js; the report says
// how each was found). Node only, because the signature database is loaded from disk.
import { patchLptModem } from './patch.js';
import { symbolsFromSignatures } from './sigdb.js';

export function patchLptBuild(img, symBytes, opts = {}) {
  let syms = symBytes;
  let pre = [];
  if (!syms) { syms = symbolsFromSignatures(img); pre = syms.report; }
  const r = patchLptModem(img, syms, opts);
  return { ...r, report: [...pre, ...r.report] };
}
