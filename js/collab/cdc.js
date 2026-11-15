// Content-defined chunking (gear hash, FastCDC-style) and a chunk cache.
//
// The host sends the PDF to the guests after every compile. A big report is
// megabytes, and most of it — images, fonts, untouched pages — is byte for
// byte the same as in the previous compile. Cutting the file where its
// CONTENT says (not at fixed offsets) keeps those regions in identical chunks
// even when text earlier in the file grows or shrinks, so only the chunks
// that really changed travel; the rest is rebuilt from what the guest has.

import { hex } from './bytes.js';
import { sha256 } from './crypto.js';

// 256 pseudo-random 32-bit values, the same on every machine (fixed seed).
const GEAR = (() => {
  const t = new Uint32Array(256);
  let s = 0x2545f491;
  for (let i = 0; i < 256; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    t[i] = s;
  }
  return t;
})();

const topMask = (bits) => ((0xffffffff << (32 - bits)) >>> 0);

/** Cut points of `bytes` → array of [start, end). */
export function cutPoints(bytes, { min = 8 * 1024, avg = 32 * 1024, max = 192 * 1024 } = {}) {
  const bits = Math.round(Math.log2(avg));
  const strict = topMask(bits + 1); // harder to match before the average size…
  const loose = topMask(bits - 1);  // …easier after it (normalized chunking)
  const out = [];
  const n = bytes.length;
  let start = 0;
  while (start < n) {
    if (n - start <= min) { out.push([start, n]); break; }
    let h = 0;
    let i = start + min;
    const avgAt = start + avg;
    const end = Math.min(n, start + max);
    let cut = end;
    for (; i < end; i++) {
      h = ((h << 1) + GEAR[bytes[i]]) >>> 0;
      if ((h & (i < avgAt ? strict : loose)) === 0) { cut = i + 1; break; }
    }
    out.push([start, cut]);
    start = cut;
  }
  return out;
}

/** Split and hash. Returns [{ hash, bytes }] in file order. */
export async function chunkify(bytes, opts) {
  const parts = cutPoints(bytes, opts);
  return Promise.all(parts.map(async ([a, b]) => {
    const piece = bytes.subarray(a, b);
    return { hash: hex(await sha256(piece)).slice(0, 32), bytes: piece };
  }));
}

/** Bounded cache of chunks by hash (oldest out first). */
export class ChunkCache {
  constructor(maxBytes = 256 * 1024 * 1024) {
    this.max = maxBytes;
    this.size = 0;
    this.map = new Map();
  }
  has(h) { return this.map.has(h); }
  get(h) {
    const v = this.map.get(h);
    if (v) { this.map.delete(h); this.map.set(h, v); } // refresh
    return v;
  }
  put(h, bytes) {
    if (this.map.has(h)) { this.get(h); return; }
    const copy = bytes.slice(); // own the memory (subarrays pin whole files)
    this.map.set(h, copy);
    this.size += copy.length;
    while (this.size > this.max && this.map.size > 1) {
      const [k, v] = this.map.entries().next().value;
      this.map.delete(k);
      this.size -= v.length;
    }
  }
  /** Rebuild a file from its hash list, or null if a chunk is missing. */
  assemble(hashes, total) {
    const out = new Uint8Array(total);
    let o = 0;
    for (const h of hashes) {
      const c = this.get(h);
      if (!c || o + c.length > total) return null;
      out.set(c, o);
      o += c.length;
    }
    return o === total ? out : null;
  }
  missing(hashes) {
    return [...new Set(hashes.filter((h) => !this.map.has(h)))];
  }
}
