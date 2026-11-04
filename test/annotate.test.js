// The review layer's geometry (js/pdf/annotate.js): what turns a selection
// into one highlight per line, a pen stroke into a smooth path, and a click
// into the mark under it.
import { describe, it, expect } from 'vitest';
import { mergeLineRects, smoothPath, hitTest, bbox } from '../js/pdf/annotate.js';

describe('anotaciones del PDF', () => {
  it('una selección se resalta con un rectángulo por línea, sin costuras', () => {
    const rects = [
      [10, 100, 40, 12], [49, 100.5, 30, 11.5], [80, 100, 25, 12], // three runs of one line
      [10, 115, 60, 12],                                          // the next line
      [0, 0, 0.1, 12],                                            // an empty <br> box
    ];
    expect(mergeLineRects(rects)).toEqual([[10, 100, 95, 12], [10, 115, 60, 12]]);
  });

  it('dos columnas a la misma altura no se funden en una barra', () => {
    expect(mergeLineRects([[10, 100, 40, 12], [300, 100, 40, 12]])).toHaveLength(2);
  });

  it('el trazo libre se suaviza con curvas y empieza y acaba donde el usuario', () => {
    const d = smoothPath([0, 0, 10, 5, 20, 0, 30, 5, 40, 0]);
    expect(d.startsWith('M0 0')).toBe(true);
    expect(d).toContain('Q');
    expect(d.endsWith('L40 0')).toBe(true);
    expect(smoothPath([5, 5])).toBe('M5 5 h0.01'); // a dot is still visible
  });

  it('clic sobre una marca: la encuentra por su forma, no por su caja', () => {
    const ring = { t: 'ellipse', w: 2, x0: 0, y0: 0, x1: 100, y1: 50 };
    expect(hitTest(ring, 100, 25, 2)).toBe(true);  // on the outline
    expect(hitTest(ring, 50, 25, 2)).toBe(false);  // the empty middle
    const hl = { t: 'mark', k: 'hl', rects: [[10, 10, 50, 12]] };
    expect(hitTest(hl, 30, 15, 0)).toBe(true);
    expect(bbox(hl)).toEqual([10, 10, 60, 22]);
    const arrow = { t: 'arrow', w: 2, x0: 0, y0: 0, x1: 100, y1: 0 };
    expect(hitTest(arrow, 50, 1, 2)).toBe(true);
    expect(hitTest(arrow, 50, 10, 2)).toBe(false);
  });
});
