import { describe, it, expect } from 'vitest';
import { loupeGeometry } from '../js/pdf/loupe-geometry.js';

const LSIZE = 200;
const g = (zoom, dpr = 1, pad = 1.8) => loupeGeometry({ lsize: LSIZE, dpr, zoom, pad });

describe('loupe geometry', () => {
  it('magnifies by exactly the requested factor', () => {
    // The regression that shipped: the loupe showed the page 1:1 because the
    // backing canvas was sized with the zoom factor AND the sampled region was
    // the same number of pixels.
    for (const z of [1.5, 2, 3, 4.5, 8, 16]) {
      expect(g(z).magnification).toBeCloseTo(z, 10);
    }
  });

  it('shows less of the page the more it magnifies', () => {
    expect(g(2).pageCss).toBe(100);   // 200 CSS px of screen show 100 of page
    expect(g(4).pageCss).toBe(50);
    expect(g(8).pageCss).toBe(25);
  });

  it('is a 1:1 pixel copy — nothing is resampled', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const r = g(3, dpr);
      expect(r.sample).toBe(r.backing);
      // …and the tile really does carry that many pixels for the region shown.
      expect(r.pageCss * r.density).toBeCloseTo(r.backing, 6);
    }
  });

  it('rasterizes at zoom × device density, which is what keeps it sharp', () => {
    // A 4× loupe on a 2× screen needs the page at 8 device px per CSS px.
    expect(g(4, 2).density).toBe(8);
    expect(g(3, 1).density).toBe(3);
  });

  it('honours the device pixel ratio in the backing canvas', () => {
    expect(g(3, 1).backing).toBe(200);
    expect(g(3, 2).backing).toBe(400);
    expect(g(3, 1.5).backing).toBe(300);
  });

  it('costs the same at any magnification', () => {
    // The tile shrinks in page units exactly as fast as its density grows, so
    // a 16× loupe rasterizes no more pixels than a 2× one.
    const px = [2, 4, 8, 16].map((z) => g(z).tilePx);
    expect(new Set(px).size).toBe(1);
    expect(px[0]).toBe(Math.round(LSIZE * 1.8));
  });

  it('keeps a margin around the glass so small moves reuse the tile', () => {
    const r = g(4);
    expect(r.tileCss).toBeGreaterThan(r.pageCss);
    expect(r.tileCss / r.pageCss).toBeCloseTo(1.8, 6);
  });
});
