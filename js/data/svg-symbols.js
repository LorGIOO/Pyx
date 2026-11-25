// Symbols of one's own drawn from an .svg file («Mis símbolos → SVG…»).
//
// The drawing becomes TikZ code with the svg.path library — its `svg {…}`
// path takes the very path data an SVG file holds — so it compiles with any
// engine and with nothing to install: the command scales with the text
// (\resizebox to the height of a capital letter) and takes the text's colour.
// Kept in symbols.json, as a fourth field of the symbol: { svg, tikz }.

import { createSignal } from 'solid-js';

// [[glyph, command, name, extra?], …] — «Mis símbolos», shared by the panel,
// the editor (which draws them in place of the command) and the compiler
// (which defines the ones a document uses).
export const [mySymbols, setMySymbols] = createSignal([]);

const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const fmt = (n) => {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? '0' : String(v);
};

/** Path data with every number spelled plainly and one space between tokens
 *  (svg.path does not read `1.5-2`, `.5.5` or exponents). */
export function normalizePath(d) {
  const out = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  let m;
  let cmd = '';
  let argN = 0;
  while ((m = re.exec(String(d || '')))) {
    if (m[1]) { cmd = m[1]; argN = 0; out.push(cmd); continue; }
    // Arc flags may be written together («a1 1 0 01 2 2»): split them.
    if ((cmd === 'A' || cmd === 'a') && (argN % 7 === 3 || argN % 7 === 4) && /^[01]{2,}/.test(m[2])) {
      for (const ch of m[2]) { out.push(ch); argN++; }
      continue;
    }
    out.push(fmt(parseFloat(m[2])));
    argN++;
  }
  return out.join(' ');
}

const nums = (s) => (String(s || '').match(NUM) || []).map(Number);

/** One SVG shape as path data, or ''. */
function shapePath(el) {
  const a = (k) => parseFloat(el.getAttribute(k) || '0') || 0;
  switch (el.tagName.toLowerCase()) {
    case 'path': return el.getAttribute('d') || '';
    case 'rect': {
      const x = a('x'), y = a('y'), w = a('width'), h = a('height');
      return w && h ? `M${x} ${y}H${x + w}V${y + h}H${x}Z` : '';
    }
    case 'circle': case 'ellipse': {
      const cx = a('cx'), cy = a('cy');
      const rx = el.tagName.toLowerCase() === 'circle' ? a('r') : a('rx');
      const ry = el.tagName.toLowerCase() === 'circle' ? a('r') : a('ry');
      if (!rx || !ry) return '';
      // four Bézier quarters (arcs are the least dependable part of svg.path)
      const k = 0.5523, kx = rx * k, ky = ry * k;
      return `M${cx + rx} ${cy}C${cx + rx} ${cy + ky} ${cx + kx} ${cy + ry} ${cx} ${cy + ry}`
        + `C${cx - kx} ${cy + ry} ${cx - rx} ${cy + ky} ${cx - rx} ${cy}`
        + `C${cx - rx} ${cy - ky} ${cx - kx} ${cy - ry} ${cx} ${cy - ry}`
        + `C${cx + kx} ${cy - ry} ${cx + rx} ${cy - ky} ${cx + rx} ${cy}Z`;
    }
    case 'line': return `M${a('x1')} ${a('y1')}L${a('x2')} ${a('y2')}`;
    case 'polygon': case 'polyline': {
      const p = nums(el.getAttribute('points'));
      if (p.length < 4) return '';
      let d = `M${p[0]} ${p[1]}`;
      for (let k = 2; k + 1 < p.length; k += 2) d += `L${p[k]} ${p[k + 1]}`;
      return el.tagName.toLowerCase() === 'polygon' ? d + 'Z' : d;
    }
    default: return '';
  }
}

/** A style property of an element, from its attribute or its style="". */
function prop(el, k) {
  const st = el.getAttribute('style') || '';
  const m = st.match(new RegExp(`(?:^|;)\\s*${k}\\s*:\\s*([^;]+)`));
  return (m ? m[1] : el.getAttribute(k) || '').trim();
}
function inherited(el, k) {
  for (let e = el; e && e.nodeType === 1; e = e.parentNode) {
    const v = prop(e, k);
    if (v) return v;
  }
  return '';
}

/**
 * The TikZ drawing of an SVG file: { tikz, w, h } — or throws with the reason.
 * Shapes with a fill are filled, those with only a stroke are drawn; all in
 * the colour of the text. Transforms other than translate are not applied.
 */
export function svgToTikz(svgText) {
  const doc = new DOMParser().parseFromString(String(svgText), 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.tagName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) {
    throw new Error('El archivo no es un SVG válido.');
  }
  let vb = nums(svg.getAttribute('viewBox'));
  if (vb.length !== 4) vb = [0, 0, parseFloat(svg.getAttribute('width')) || 24, parseFloat(svg.getAttribute('height')) || 24];
  const [vx, vy, vw, vh] = vb;
  const parts = [];
  for (const el of svg.querySelectorAll('path,rect,circle,ellipse,line,polygon,polyline')) {
    if (el.closest('defs,clipPath,mask,symbol')) continue;
    let d = shapePath(el);
    if (!d) continue;
    // translate(…) on the element or its groups
    let tx = 0, ty = 0;
    for (let e = el; e && e !== svg.parentNode && e.nodeType === 1; e = e.parentNode) {
      const t = (e.getAttribute('transform') || '').match(/translate\(\s*([^)]*)\)/);
      if (t) { const [x = 0, y = 0] = nums(t[1]); tx += x; ty += y; }
    }
    const fill = inherited(el, 'fill');
    const stroke = inherited(el, 'stroke');
    const sw = parseFloat(inherited(el, 'stroke-width')) || 1;
    const rule = inherited(el, 'fill-rule') === 'evenodd' ? ',even odd rule' : '';
    const shift = tx || ty ? `,shift={(${fmt(tx)}pt,${fmt(ty)}pt)}` : '';
    const isLine = /^(line|polyline)$/i.test(el.tagName);
    const filled = fill !== 'none' && !isLine;
    const drawn = stroke && stroke !== 'none';
    const op = filled && drawn ? `\\filldraw[line width=${fmt(sw)}pt${rule}${shift}]`
      : filled ? `\\fill[${rule.slice(1)}${shift}]`.replace('[,', '[') : `\\draw[line width=${fmt(sw)}pt${shift}]`;
    parts.push(`${op} svg{${normalizePath(d)}};`);
  }
  if (!parts.length) throw new Error('El SVG no tiene ninguna forma que dibujar (trayectos, rectángulos, círculos…).');
  // The viewBox, invisible, so the symbol keeps its own margins.
  const box = `\\path(${fmt(vx)}pt,${fmt(vy)}pt)rectangle(${fmt(vx + vw)}pt,${fmt(vy + vh)}pt);`;
  return { tikz: `\\tikz[yscale=-1]{${box}${parts.join('')}}`, w: vw, h: vh };
}

/** A command name made from a file name: letters only (\miSimbolo). */
export function commandFromName(name) {
  const base = String(name || '').replace(/^.*[\\/]/, '').replace(/\.svg$/i, '');
  const ascii = base.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const words = ascii.split(/[^A-Za-z]+/).filter(Boolean);
  const cmd = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase())).join('');
  return '\\' + (cmd || 'simbolo');
}

/** The LaTeX definition of a symbol drawn from an SVG. */
export function svgDefinition(cmd, tikz) {
  return `\\providecommand{${cmd}}{\\raisebox{-0.12em}{\\resizebox{!}{0.85em}{${tikz}}}}`;
}

/** The SVG symbols a text uses: [{ cmd, def }]. */
export function svgSymbolsUsed(text) {
  const out = [];
  for (const it of mySymbols()) {
    const x = it[3];
    if (!x || !x.tikz) continue;
    const name = it[1].replace(/^\\/, '');
    if (new RegExp(`\\\\${name}(?![A-Za-z@])`).test(text)) out.push({ cmd: it[1], def: svgDefinition(it[1], x.tikz) });
  }
  return out;
}
