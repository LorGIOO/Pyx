import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOutput, setOutput, deleteOutput, clearDoc, clearAll, gcDoc,
  serializeDoc, hydrateDoc,
} from '../js/editor/cell-outputs.js';
import { hashString, randomId } from '../js/core/hash.js';

beforeEach(() => clearAll());

describe('output store', () => {
  it('namespaces results per document', () => {
    // Two files whose first cell shares a key must not see each other's result.
    setOutput(1, '#0', { ok: true, result: 'uno' });
    setOutput(2, '#0', { ok: true, result: 'dos' });
    expect(getOutput(1, '#0').result).toBe('uno');
    expect(getOutput(2, '#0').result).toBe('dos');
  });

  it('drops the results of a document when it closes', () => {
    setOutput(1, 'a', { ok: true });
    clearDoc(1);
    expect(getOutput(1, 'a')).toBeUndefined();
  });

  it('garbage-collects results whose cell no longer exists', () => {
    setOutput(1, 'vive', { ok: true });
    setOutput(1, 'borrada', { ok: true, images: ['x'.repeat(1000)] });
    gcDoc(1, new Set(['vive']));
    expect(getOutput(1, 'vive')).toBeDefined();
    expect(getOutput(1, 'borrada')).toBeUndefined();
  });

  it('deletes a single result', () => {
    setOutput(1, 'a', { ok: true });
    deleteOutput(1, 'a');
    expect(getOutput(1, 'a')).toBeUndefined();
  });
});

describe('persistence', () => {
  it('round-trips a successful result', () => {
    const h = hashString('x = 1');
    setOutput(1, 'aaa', { ok: true, stdout: '2\n', result: '2', codeHash: h });
    const json = serializeDoc(1, new Map([['aaa', h]]));
    expect(json).toBeTruthy();

    clearAll();
    hydrateDoc(7, json, new Map([['aaa', h]]));
    const out = getOutput(7, 'aaa');
    expect(out.stdout).toBe('2\n');
    expect(out.result).toBe('2');
    expect(out.restored).toBe(true);
    expect(out.running).toBe(false);
  });

  it('discards a stored result whose cell has changed', () => {
    // A number that no longer matches its formula must never come back looking
    // current — that is the most expensive kind of bug in a calculation report.
    const oldHash = hashString('x = 1');
    setOutput(1, 'aaa', { ok: true, result: '1', codeHash: oldHash });
    const json = serializeDoc(1, new Map([['aaa', oldHash]]));

    clearAll();
    hydrateDoc(1, json, new Map([['aaa', hashString('x = 2')]]));
    expect(getOutput(1, 'aaa')).toBeUndefined();
  });

  it('never stores a failed or running result', () => {
    setOutput(1, 'a', { ok: false, codeHash: 'h' });
    setOutput(1, 'b', { running: true, ok: true, codeHash: 'h' });
    expect(serializeDoc(1, new Map([['a', 'h'], ['b', 'h']]))).toBe(null);
  });

  it('is null when there is nothing to save', () => {
    expect(serializeDoc(99, new Map())).toBe(null);
  });

  it('survives malformed stored data', () => {
    expect(() => hydrateDoc(1, 'no es json', new Map())).not.toThrow();
    expect(() => hydrateDoc(1, '{"v":99}', new Map())).not.toThrow();
    expect(getOutput(1, 'a')).toBeUndefined();
  });

  it('keeps the document light by capping stored figure data', () => {
    // 20 MB of figures across four cells: the budget lets some through with
    // their images and stores the rest as text only.
    const big = 'A'.repeat(5 * 1024 * 1024);
    const hashes = new Map();
    for (let i = 0; i < 4; i++) {
      const key = 'c' + i;
      hashes.set(key, 'h');
      setOutput(1, key, { ok: true, result: String(i), images: [big], codeHash: 'h' });
    }
    const json = serializeDoc(1, hashes);
    const data = JSON.parse(json);
    const withImages = Object.values(data.cells).filter((c) => c.images.length);
    expect(Object.keys(data.cells)).toHaveLength(4); // every result is kept…
    expect(withImages.length).toBeLessThan(4);       // …but not every figure
    expect(json.length).toBeLessThan(14 * 1024 * 1024);
  });
});

describe('hash', () => {
  it('is stable and order-sensitive', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('acb'));
    expect(hashString('')).toBe(hashString(''));
  });
  it('separates near-identical cell bodies', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) seen.add(hashString(`x = ${i}`));
    expect(seen.size).toBe(2000);
  });
  it('mints distinct cell ids', () => {
    const ids = new Set();
    for (let i = 0; i < 500; i++) ids.add(randomId());
    expect(ids.size).toBeGreaterThan(495);
  });
});
