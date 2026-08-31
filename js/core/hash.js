// One string hash for the whole app.
//
// Used as a CONTENT FINGERPRINT in several caches (cell code, protected-range
// scans, build files). Those caches used to key on the full text — which, on a
// project of tens of megabytes, meant retaining several complete copies of the
// document in memory just to answer "did this change?". A 64-bit fingerprint
// answers the same question in 16 bytes.
//
// FNV-1a run over two independent 32-bit lanes: cheap, allocation-free, and
// with a collision probability low enough for change detection over a
// project's worth of files (~2^-64 per pair).

export function hashString(str) {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0xc2b2ae35 | 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b);
  }
  return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36));
}

/** Short, URL/marker-safe random identifier (8 chars, ~41 bits). Used for the
 *  stable `id=` a Python cell carries in its `%#python` marker. */
export function randomId() {
  let s = '';
  // crypto is always present in a WebView; the Math.random path is only for
  // non-browser test runners.
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  if (g.crypto && g.crypto.getRandomValues) {
    const b = new Uint8Array(6);
    g.crypto.getRandomValues(b);
    for (const v of b) s += (v % 36).toString(36);
    return s + (Date.now() % 36).toString(36).slice(-2);
  }
  while (s.length < 8) s += Math.floor(Math.random() * 36).toString(36);
  return s.slice(0, 8);
}
