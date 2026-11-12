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

import { eraseAt, applyHandle, handlesOf, linePoints, markPaths, snapAngle } from '../js/pdf/annot-geom.js';

describe('anotaciones: editar, borrar por partes y variantes', () => {
  it('el borrador parcial parte un trazo en dos y deja el resto', () => {
    const pen = { t: 'pen', c: '#000', w: 2, pts: [0, 0, 100, 0] };
    const out = eraseAt([pen], 50, 0, 5, false);
    expect(out.length).toBe(2);
    expect(Math.max(...out[0].pts.filter((_, i) => i % 2 === 0))).toBeLessThan(50);
    expect(Math.min(...out[1].pts.filter((_, i) => i % 2 === 0))).toBeGreaterThan(50);
  });
  it('el borrador parcial no toca flechas ni textos; el entero se los lleva', () => {
    const arrow = { t: 'arrow', c: '#000', w: 2, x0: 0, y0: 0, x1: 100, y1: 0 };
    expect(eraseAt([arrow], 50, 0, 5, false)).toBe(null);
    expect(eraseAt([arrow], 50, 0, 5, true)).toEqual([]);
    expect(eraseAt([arrow], 50, 40, 5, true)).toBe(null); // lejos: nada
  });
  it('un recuadro cortado conserva sus esquinas (segmentos rectos)', () => {
    const rect = { t: 'rect', c: '#000', w: 1, x0: 0, y0: 0, x1: 100, y1: 60 };
    const out = eraseAt([rect], 50, 0, 4, false);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.every((p) => p.t === 'pen' && p.poly)).toBe(true);
  });
  it('tiradores: 8 en un recuadro, 3 en una línea; el del centro la curva', () => {
    const rect = { t: 'rect', c: '#000', w: 1, x0: 10, y0: 10, x1: 50, y1: 40 };
    expect(handlesOf(rect).map((h) => h.id)).toEqual(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);
    applyHandle(rect, 'se', 80, 70, { ...rect }, false);
    expect([rect.x0, rect.y0, rect.x1, rect.y1]).toEqual([10, 10, 80, 70]);
    const line = { t: 'line', c: '#000', w: 1, x0: 0, y0: 0, x1: 100, y1: 0 };
    expect(handlesOf(line).length).toBe(3);
    applyHandle(line, 'mid', 50, 30, { ...line }, false);
    expect(line.kind).toBe('curve');
    // The curve passes through the point the handle was dropped at.
    const mid = linePoints(line)[16];
    expect(mid[0]).toBeCloseTo(50, 5);
    expect(mid[1]).toBeCloseTo(30, 5);
    applyHandle(line, 'mid', 50, 30, { ...line }, true); // Mayús: recta otra vez
    expect(line.kind).toBeUndefined();
  });
  it('Mayús bloquea a 0°/45°/90°', () => {
    const [x, y] = snapAngle(0, 0, 100, 8);
    expect(y).toBeCloseTo(0, 6);
    const [x2, y2] = snapAngle(0, 0, 70, 60);
    expect(x2).toBeCloseTo(y2, 6);
    expect(x).toBeGreaterThan(99);
  });
  it('flecha de dos puntas en codo: asta y dos cabezas', () => {
    const a = { t: 'arrow', c: '#000', w: 2, x0: 0, y0: 0, x1: 100, y1: 60, kind: 'elbow', el: 'h', heads: 'both' };
    const paths = markPaths(a);
    expect(paths.length).toBe(3);
    expect(paths.filter((p) => p.fill).length).toBe(2);
  });
});
