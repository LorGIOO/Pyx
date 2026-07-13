// Reactive view of the active document's text, plus parsers that drive the
// side panel (TOC = sectioning tree; Estructura = how the file relates to
// others via \input/\include/\subfile).

import { createSignal } from 'solid-js';

export const [docText, setDocText] = createSignal('');

const LEVEL = {
  part: 0, chapter: 1, section: 2, subsection: 3,
  subsubsection: 4, paragraph: 5, subparagraph: 6,
};

const HEAD_RE = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*\{/;

/** Sectioning entries with their 1-based line number (for jump-to-line). */
export function parseTOC(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEAD_RE);
    if (!m) continue;
    const open = lines[i].indexOf('{', m.index);
    let depth = 1, j = open + 1, title = '';
    while (j < lines[i].length && depth > 0) {
      const c = lines[i][j];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
      title += c;
      j++;
    }
    out.push({
      level: LEVEL[m[1]], kind: m[1], star: m[2] === '*',
      title: title.trim() || '(sin título)', line: i + 1,
    });
  }
  return out;
}

/** TODO entries (TeXstudio lists them in the structure): `% TODO …` comments
 * and \todo{…} commands, with their 1-based line. */
export function parseTodos(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let m = lines[i].match(/%\s*(TODO|FIXME)\b[:\s]*(.*)$/i);
    if (!m) {
      const c = lines[i].match(/\\todo\s*(?:\[[^\]]*\])?\{([^}]*)\}/);
      if (c) m = [null, 'TODO', c[1]];
    }
    if (m) out.push({ tag: m[1].toUpperCase(), text: (m[2] || '').trim(), line: i + 1 });
  }
  return out;
}

/** The section path (breadcrumbs) that contains a given 1-based line. */
export function crumbPath(toc, line) {
  const path = [];
  for (const h of toc) {
    if (h.line > line) break;
    while (path.length && path[path.length - 1].level >= h.level) path.pop();
    path.push(h);
  }
  return path;
}

/** Word count, TeXstudio-style: prose only — Python cells, comments, LaTeX
 * commands, math and braces don't count. */
export function countWords(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let inCell = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!inCell && t.startsWith('%#python')) { inCell = true; continue; }
    if (inCell) { if (t.startsWith('%#end')) inCell = false; continue; }
    // strip comments (an escaped \% is not a comment)
    let s = raw;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '%' && (i === 0 || s[i - 1] !== '\\')) { s = s.slice(0, i); break; }
    }
    kept.push(s);
  }
  let s = kept.join('\n');
  s = s.replace(/\\\[[\s\S]*?\\\]/g, ' ').replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ');           // math doesn't count
  s = s.replace(/\\[a-zA-Z@]+\*?/g, ' ');     // commands don't count
  s = s.replace(/[{}[\]()~&_^\\]/g, ' ');     // markup leftovers
  const m = s.match(/[\p{L}\p{M}\p{N}]+(?:[-'’][\p{L}\p{M}\p{N}]+)*/gu);
  return m ? m.length : 0;
}

/** Files this document pulls in (its children in the project structure). */
export function parseIncludes(text) {
  const out = [];
  const re = /\\(input|include|subfile|import)\s*(?:\[[^\]]*\])?\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    let target = m[2].trim();
    if (target && !/\.[a-z]+$/i.test(target)) target += '.tex';
    out.push({ cmd: m[1], target });
  }
  return out;
}
