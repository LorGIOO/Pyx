import { describe, it, expect } from 'vitest';
import { diffLines, hunks } from '../js/editor/line-diff.js';

const show = (d) => d.map((x) => x.type + x.text).join('|');

describe('line diff', () => {
  it('finds a changed line between kept ones', () => {
    expect(show(diffLines('a\nb\nc', 'a\nB\nc'))).toBe(' a|-b|+B| c');
  });
  it('insertions and deletions, with line numbers', () => {
    const d = diffLines('uno\ndos\ntres', 'cero\nuno\ntres\ncuatro');
    expect(show(d)).toBe('+cero| uno|-dos| tres|+cuatro');
    expect(d.find((x) => x.text === 'tres')).toMatchObject({ a: 3, b: 3 });
  });
  it('identical and empty texts', () => {
    expect(show(diffLines('x\ny', 'x\ny'))).toBe(' x| y');
    expect(show(diffLines('', 'a'))).toBe('-|+a');
  });
  it('hunks keep only the changes and their context', () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const neu = old.replace('l10', 'X');
    const h = hunks(diffLines(old, neu), 1);
    expect(show(h)).toBe('…| l9|-l10|+X| l11|…');
  });
});
