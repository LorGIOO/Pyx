import { describe, it, expect, beforeEach } from 'vitest';
import { createLedger } from '../js/editor/ns-ledger.js';

let led;
const DIR = '/proj';
beforeEach(() => { led = createLedger(); led.reset(DIR); });

const run = (hashes) => { for (const h of hashes) led.record(h, DIR); };

describe('namespace ledger', () => {
  it('skips nothing on a fresh kernel', () => {
    expect(led.prefix(['a', 'b'], DIR)).toBe(0);
  });

  it('skips the cells already executed, in order', () => {
    run(['a', 'b']);
    // Only the third cell is new: the first two already built this namespace.
    expect(led.prefix(['a', 'b', 'c'], DIR)).toBe(2);
  });

  it('skips everything when nothing changed', () => {
    run(['a', 'b']);
    expect(led.prefix(['a', 'b'], DIR)).toBe(2);
  });

  it('refuses to skip when an EARLIER cell changed', () => {
    // This is the case that makes the optimization safe: editing cell 1 must
    // re-run cell 2, because cell 2 was computed from the old cell 1.
    run(['a', 'b', 'c']);
    expect(led.prefix(['a', 'X', 'c'], DIR)).toBe(0);
  });

  it('refuses to skip when a cell was deleted', () => {
    run(['a', 'b', 'c']);
    expect(led.prefix(['a', 'b'], DIR)).toBe(0);
  });

  it('refuses to skip when a cell was inserted at the front', () => {
    run(['a', 'b']);
    expect(led.prefix(['nueva', 'a', 'b'], DIR)).toBe(0);
  });

  it('refuses to skip after a failed cell', () => {
    run(['a']);
    led.invalidate(); // what execCell does when a cell raises
    expect(led.prefix(['a', 'b'], DIR)).toBe(0);
  });

  it('refuses to skip after an interrupt or a kernel restart', () => {
    run(['a', 'b']);
    led.invalidate();
    expect(led.prefix(['a', 'b'], DIR)).toBe(0);
    led.reset(DIR); // a real reset makes the ledger authoritative again
    run(['a']);
    expect(led.prefix(['a', 'b'], DIR)).toBe(1);
  });

  it('refuses to skip when the working directory changed', () => {
    // The kernel chdir'd: relative paths and figure output would differ.
    run(['a', 'b']);
    expect(led.prefix(['a', 'b'], '/otro')).toBe(0);
  });

  it('stops trusting the ledger once a cell ran from another directory', () => {
    run(['a']);
    led.record('b', '/otro');
    expect(led.state().known).toBe(false);
    expect(led.prefix(['a', 'b'], '/otro')).toBe(0);
  });

  it('records nothing while the namespace is unknown', () => {
    led.invalidate();
    run(['a', 'b']);
    expect(led.state().chain).toEqual([]);
  });

  it('handles the empty document', () => {
    expect(led.prefix([], DIR)).toBe(0);
    run(['a']);
    expect(led.prefix([], DIR)).toBe(0); // ledger longer than the target
  });
});
