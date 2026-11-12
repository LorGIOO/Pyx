// The LaTeX the table and figure assistants write — pure functions, so what
// the dialog previews is exactly what is inserted, and it can be unit-tested.

import { escapeCell } from './paste-table.js';

const pad = (n) => '  '.repeat(n);

/**
 * A table.
 * @param {object} o
 * @param {string[][]} o.cells   rows of cell texts (ragged rows are completed)
 * @param {string[]} [o.align]   per column: 'l' | 'c' | 'r' | 'p' (paragraph)
 * @param {string} [o.pWidth]    width of the 'p' columns (default 3cm)
 * @param {'booktabs'|'hline'|'grid'|'none'} [o.rules]
 * @param {boolean} [o.vlines]   vertical lines between columns
 * @param {boolean} [o.header]   the first row is a header (a rule below it)
 * @param {boolean} [o.headerBold]
 * @param {boolean} [o.escape]   cells are plain text: escape % & _ # $ …
 * @param {'htbp'|'H'|'t'|'b'|'p'|'none'} [o.float]  'none' = only the tabular
 * @param {boolean} [o.centering]
 * @param {string} [o.caption]
 * @param {'top'|'bottom'} [o.captionPos]
 * @param {string} [o.label]     without the "tab:" prefix
 * @param {''|'small'|'footnotesize'|'scriptsize'} [o.size]
 * @param {boolean} [o.fit]      scale down to the text width when wider
 */
export function tableLatex(o) {
  const rows = (o.cells && o.cells.length ? o.cells : [['']]).map((r) => r.map((c) => String(c == null ? '' : c)));
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const rules = o.rules || 'booktabs';
  const grid = rules === 'grid';
  const vl = o.vlines || grid ? '|' : '';
  const spec = Array.from({ length: cols }, (_, j) => {
    const a = (o.align && o.align[j]) || 'l';
    return a === 'p' ? `p{${o.pWidth || '3cm'}}` : a;
  });
  const colSpec = vl ? `|${spec.join('|')}|` : spec.join('');
  const text = (c) => (o.escape === false ? c.trim() : escapeCell(c));
  const line = (r, head) => Array.from({ length: cols }, (_, j) => {
    const t = text(r[j] || '');
    return head && o.headerBold && t ? `\\textbf{${t}}` : t;
  }).join(' & ') + ' \\\\';
  const [top, mid, bot] = {
    booktabs: ['\\toprule', '\\midrule', '\\bottomrule'],
    hline: ['\\hline', '\\hline', '\\hline'],
    grid: ['\\hline', '\\hline', '\\hline'],
    none: [null, null, null],
  }[rules] || [null, null, null];

  const isFloat = o.float && o.float !== 'none';
  const d = isFloat ? 1 : 0; // indentation depth of the tabular
  const body = [];
  if (top) body.push(top);
  rows.forEach((r, i) => {
    const head = !!o.header && i === 0;
    body.push(line(r, head));
    if (head && mid && rows.length > 1) body.push(mid);
    else if (grid && i < rows.length - 1) body.push('\\hline');
  });
  if (bot) body.push(bot);
  let tab = [`${pad(d)}\\begin{tabular}{${colSpec}}`, ...body.map((l) => pad(d + 1) + l), `${pad(d)}\\end{tabular}`];
  // Wider than the text? \resizebox with a 100 % cap: it shrinks a table that
  // does not fit and leaves one that does at its natural size.
  if (o.fit) {
    tab = [`${pad(d)}\\resizebox{\\ifdim\\width>\\linewidth\\linewidth\\else\\width\\fi}{!}{%`, ...tab.map((l) => pad(1) + l), `${pad(d)}}`];
  }
  if (!isFloat) {
    const lines = o.size ? [`{\\${o.size}`, ...tab, '}'] : tab;
    return lines.join('\n');
  }
  const cap = [];
  if (o.caption) cap.push(`${pad(1)}\\caption{${o.caption}}`);
  if (o.label) cap.push(`${pad(1)}\\label{tab:${o.label}}`);
  const out = [`\\begin{table}[${o.float}]`];
  if (o.centering !== false) out.push(`${pad(1)}\\centering`);
  if (o.size) out.push(`${pad(1)}\\${o.size}`);
  if (o.captionPos !== 'bottom') out.push(...cap);
  out.push(...tab);
  if (o.captionPos === 'bottom') out.push(...cap);
  out.push('\\end{table}');
  return out.join('\n');
}

/** Packages a table written with these options needs (for the dialog's note). */
export function tablePackages(o) {
  const need = [];
  if ((o.rules || 'booktabs') === 'booktabs') need.push('booktabs');
  if (o.fit) need.push('graphicx');
  if (o.float === 'H') need.push('float');
  return need;
}

const num = (v, d = 3) => String(+(+v).toFixed(d));

/**
 * A figure: one image, or several side by side as subfigures.
 * @param {object} o
 * @param {{path: string, caption?: string}[]} o.images
 * @param {'textwidth'|'cm'|'natural'} [o.unit]   what `width` means
 * @param {number} [o.width]     fraction of the text width (0–1), or cm
 * @param {number} [o.height]    cm; 0 = not set
 * @param {number} [o.angle]
 * @param {number} [o.perRow]    subfigures per row (several images)
 * @param {'htbp'|'H'|'t'|'b'|'p'|'none'} [o.float]
 * @param {boolean} [o.centering]
 * @param {string} [o.caption]
 * @param {'top'|'bottom'} [o.captionPos]
 * @param {string} [o.label]     without the "fig:" prefix
 */
export function figureLatex(o) {
  const images = (o.images || []).filter((im) => im && String(im.path || '').trim());
  const list = images.length ? images : [{ path: 'imagen.png' }];
  const isFloat = o.float && o.float !== 'none';
  const opts = (width) => {
    const out = [];
    if (width) out.push(width);
    if (o.height > 0) out.push(`height=${num(o.height)}cm`);
    if (width && o.height > 0) out.push('keepaspectratio');
    if (o.angle) out.push(`angle=${num(o.angle)}`);
    return out.length ? `[${out.join(', ')}]` : '';
  };
  const own = o.unit === 'cm' ? `width=${num(o.width || 8)}cm`
    : o.unit === 'natural' ? '' : `width=${num(o.width || 0.8)}\\textwidth`;
  const inner = [];
  if (list.length === 1) {
    inner.push(`\\includegraphics${opts(own)}{${list[0].path.trim()}}`);
  } else {
    // Side by side: each image fills its own subfigure; the row shares the
    // text width, with a little air between them.
    const per = Math.max(1, Math.min(list.length, o.perRow || list.length));
    const w = num(Math.floor((0.98 / per) * 100 - 1) / 100, 2);
    list.forEach((im, i) => {
      inner.push(`\\begin{subfigure}[b]{${w}\\textwidth}`);
      inner.push(`${pad(1)}\\centering`);
      inner.push(`${pad(1)}\\includegraphics${opts('width=\\linewidth')}{${im.path.trim()}}`);
      if (im.caption) inner.push(`${pad(1)}\\caption{${im.caption}}`);
      inner.push('\\end{subfigure}');
      if (i < list.length - 1) inner.push((i + 1) % per === 0 ? '\\par\\medskip' : '\\hfill');
    });
  }
  if (!isFloat) {
    return o.centering !== false
      ? ['\\begin{center}', ...inner.map((l) => pad(1) + l), '\\end{center}'].join('\n')
      : inner.join('\n');
  }
  const cap = [];
  if (o.caption) cap.push(`${pad(1)}\\caption{${o.caption}}`);
  if (o.label) cap.push(`${pad(1)}\\label{fig:${o.label}}`);
  const out = [`\\begin{figure}[${o.float}]`];
  if (o.centering !== false) out.push(`${pad(1)}\\centering`);
  if (o.captionPos === 'top') out.push(...cap);
  out.push(...inner.map((l) => pad(1) + l));
  if (o.captionPos !== 'top') out.push(...cap);
  out.push('\\end{figure}');
  return out.join('\n');
}

export function figurePackages(o) {
  const need = ['graphicx'];
  if ((o.images || []).filter((im) => im && String(im.path || '').trim()).length > 1) need.push('subcaption');
  if (o.float === 'H') need.push('float');
  return need;
}

/** A label from a file name or a caption: lowercase, no accents, hyphens. */
export function slugLabel(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
