import { describe, it, expect } from 'vitest';
import { cutPoints, chunkify, ChunkCache } from '../js/collab/cdc.js';

function pseudoRandom(n, seed = 1) {
  const b = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; b[i] = s >>> 24; }
  return b;
}

describe('collab · troceado del PDF por contenido', () => {
  it('cubre el archivo entero sin huecos y respeta los tamaños', () => {
    const data = pseudoRandom(2_000_000);
    const cuts = cutPoints(data);
    expect(cuts[0][0]).toBe(0);
    expect(cuts[cuts.length - 1][1]).toBe(data.length);
    for (let i = 1; i < cuts.length; i++) expect(cuts[i][0]).toBe(cuts[i - 1][1]);
    for (const [a, b] of cuts.slice(0, -1)) {
      expect(b - a).toBeGreaterThanOrEqual(8 * 1024);
      expect(b - a).toBeLessThanOrEqual(192 * 1024);
    }
  });

  it('un cambio al principio solo cambia los trozos cercanos', async () => {
    const base = pseudoRandom(3_000_000, 7);
    const edited = new Uint8Array(base.length + 37);
    edited.set(base.subarray(0, 1000));
    edited.set(pseudoRandom(37, 99), 1000);
    edited.set(base.subarray(1000), 1037);
    const a = await chunkify(base);
    const b = await chunkify(edited);
    const known = new Set(a.map((c) => c.hash));
    const fresh = b.filter((c) => !known.has(c.hash));
    const freshBytes = fresh.reduce((n, c) => n + c.bytes.length, 0);
    expect(freshBytes).toBeLessThan(base.length * 0.1);
  });

  it('la caché reconstruye el archivo y dice qué falta', async () => {
    const data = pseudoRandom(500_000, 3);
    const parts = await chunkify(data);
    const cache = new ChunkCache();
    for (const p of parts.slice(1)) cache.put(p.hash, p.bytes);
    const hashes = parts.map((p) => p.hash);
    expect(cache.missing(hashes)).toEqual([parts[0].hash]);
    expect(cache.assemble(hashes, data.length)).toBeNull();
    cache.put(parts[0].hash, parts[0].bytes);
    expect(cache.assemble(hashes, data.length)).toEqual(data);
  });
});
