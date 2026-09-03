// The loupe's geometry, isolated so it can be checked without a browser.
//
// Getting this wrong is silent — the loupe either does not magnify or shows a
// blurry upscale, and both look like "it just does that". It already went wrong
// once: the backing canvas was sized LSIZE·D·Z while the sampled region was the
// same number of pixels, which is exactly 1:1 and no magnification at all.
//
// The three sizes that have to agree, for magnification Z and device ratio D:
//
//   backing   = LSIZE·D          device px in the loupe canvas
//   density   = Z·D              tile px per CSS px of page
//   sample    = backing          tile px copied into the loupe, 1:1
//
// from which the loupe shows `sample/density = LSIZE/Z` CSS px of page inside
// LSIZE CSS px of screen — magnified by exactly Z — and every pixel it paints
// came from PDF.js at that magnified resolution instead of being a blown-up
// copy of the page already on screen.

/**
 * @param {{lsize:number, dpr:number, zoom:number, pad?:number}} o
 * @returns {{backing:number, density:number, sample:number, pageCss:number,
 *            magnification:number, tileCss:number, tilePx:number}}
 */
export function loupeGeometry({ lsize, dpr, zoom, pad = 1 }) {
  const backing = Math.round(lsize * dpr);
  const density = dpr * zoom;
  const sample = backing;                 // copied 1:1, never resampled
  const pageCss = sample / density;       // CSS px of page under the glass
  const tileCss = (lsize / zoom) * pad;   // region rasterized around the cursor
  return {
    backing,
    density,
    sample,
    pageCss,
    magnification: lsize / pageCss,
    tileCss,
    // Pixels the tile canvas costs — independent of the zoom, which is what
    // makes a 16× loupe as cheap as a 2× one.
    tilePx: Math.round(tileCss * density),
  };
}
