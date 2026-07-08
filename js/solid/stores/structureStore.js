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
