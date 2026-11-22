// Night mode for the PDF that only darkens what is black and white.
//
// The old night mode inverted the whole page (CSS invert + hue-rotate): the
// paper went dark, but so did every colour — a red bar turned cyan-ish, a photo
// became a negative. This filter splits each pixel into its WHITE part
// (min(R,G,B)), its BLACK part (1 - max(R,G,B)) and what is left, its COLOUR,
// and repaints only the first two:
//
//     out = pixel - (1 - bg)·min + fg·(1 - max)·(1 - (max - min))
//
// White paper becomes `bg`, black text and formulas become `fg`, a pure colour
// (a plot line, a coloured word, a logo) is untouched, and the anti-aliased
// edge of a coloured glyph — colour blended with white — blends with the dark
// paper instead of leaving a light halo. Greys invert, as text should.
//
// SVG filters have no min/max, so they are built from min(a,b) = (a+b-|a-b|)/2
// with |x| = max(x,0) + max(-x,0) (each colour matrix clamps at 0). It runs on
// the GPU, on the canvas PDF.js's worker already painted: no extra raster.

const BG = 0.118; // #1e1e1e
const FG = 0.9;   // #e6e6e6
export const DARK_FILTER_ID = 'pyx-pdf-dark';

function filterMarkup(bg = BG, fg = FG) {
  const Z = '0 0 0 0 0', A1 = '0 0 0 0 1';
  const p = [];
  const cm = (inp, res, rows) => p.push(`<feColorMatrix in="${inp}" result="${res}" type="matrix" values="${rows.join('  ')}"/>`);
  const ar = (a, b, res, k2, k3) => p.push(`<feComposite in="${a}" in2="${b}" result="${res}" operator="arithmetic" k1="0" k2="${k2}" k3="${k3}" k4="0"/>`);
  // min and max of the R and G channels of `src`, grey in every channel
  const minmax = (src, n) => {
    cm(src, `${n}d`, ['1 -1 0 0 0', '-1 1 0 0 0', Z, A1]);
    cm(`${n}d`, `${n}ha`, ['.5 .5 0 0 0', '.5 .5 0 0 0', '.5 .5 0 0 0', A1]); // |a-b|/2
    cm(src, `${n}hs`, ['.25 .25 0 0 0', '.25 .25 0 0 0', '.25 .25 0 0 0', A1]); // (a+b)/4
    // k2 = 2, k3 = ±1 keeps alpha at 1 (the composite works premultiplied)
    ar(`${n}hs`, `${n}ha`, `${n}min`, 2, -1);
    ar(`${n}hs`, `${n}ha`, `${n}max`, 2, 1);
  };
  minmax('SourceGraphic', 'rg');
  cm('SourceGraphic', 'bo', [Z, '0 0 1 0 0', Z, A1]);           // B into the G channel
  cm('rgmin', 'mr', ['1 0 0 0 0', Z, Z, A1]); ar('mr', 'bo', 'x', 1, 1); minmax('x', 'x');
  cm('rgmax', 'Mr', ['1 0 0 0 0', Z, Z, A1]); ar('Mr', 'bo', 'y', 1, 1); minmax('y', 'y');
  cm('SourceGraphic', 'half', ['.5 0 0 0 0', '0 .5 0 0 0', '0 0 .5 0 0', A1]);
  const t1 = `${1 - bg} 0 0 0 0`;
  cm('xmin', 't1', [t1, t1, t1, A1]);
  ar('half', 't1', 'p', 2, -1);                                   // pixel - (1-bg)·min
  // The black part lights up only as much as the pixel is GREY: weighted by
  // 1 - chroma = 1 - max + min, so black text turns light but a dark colour
  // (a navy line, a dark red) keeps its colour.
  const u = '-1 0 0 0 1';
  cm('ymax', 'u', [u, u, u, A1]);                                 // 1 - max
  ar('u', 'xmin', 'grey', 1, 1);                                  // 1 - max + min
  p.push('<feComposite in="u" in2="grey" result="k" operator="arithmetic" k1="1" k2="0" k3="0" k4="0"/>');
  const t2 = `${fg} 0 0 0 0`;
  cm('k', 't2', [t2, t2, t2, A1]);
  ar('p', 't2', 'out', 1, 1);                                     // + fg·(1-max)·(1-chroma)
  return `<filter id="${DARK_FILTER_ID}" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">${p.join('')}</filter>`;
}

/** Put the filter in the page once (an invisible <svg> at the end of <body>). */
export function ensureDarkFilter() {
  if (typeof document === 'undefined' || document.getElementById(DARK_FILTER_ID)) return;
  const holder = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  holder.setAttribute('width', '0');
  holder.setAttribute('height', '0');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.position = 'absolute';
  holder.innerHTML = filterMarkup();
  document.body.appendChild(holder);
}

export { filterMarkup };
