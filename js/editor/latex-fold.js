// Code folding for LaTeX (TeXstudio's "Plegado"): \begin{env}…\end{env}
// blocks and \section/\subsection/… regions fold from the gutter. The fold
// gutter can be hidden from Configuración (CSS), the service stays cheap.

import { foldService } from '@codemirror/language';

const SECTION_RANK = {
  part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5,
};
const SCAN_CAP = 4000; // lines — bounded so huge docs stay responsive

export const latexFold = foldService.of((state, lineStart) => {
  const doc = state.doc;
  const line = doc.lineAt(lineStart);

  // \begin{env} … matching \end{env} (same name, nesting-aware).
  const env = /\\begin\{([^}*]+)\*?\}/.exec(line.text);
  if (env) {
    const name = env[1];
    const open = new RegExp(`\\\\begin\\{${name}\\*?\\}`, 'g');
    const close = new RegExp(`\\\\end\\{${name}\\*?\\}`, 'g');
    let depth = 0;
    const last = Math.min(doc.lines, line.number + SCAN_CAP);
    for (let ln = line.number; ln <= last; ln++) {
      const text = doc.line(ln).text;
      open.lastIndex = 0;
      close.lastIndex = 0;
      const opens = (text.match(open) || []).length;
      const closes = (text.match(close) || []).length;
      depth += opens - closes;
      if (depth <= 0 && ln > line.number) {
        const end = doc.line(ln);
        return { from: line.to, to: end.from - 1 < line.to ? end.to : end.from - 1 };
      }
      if (depth <= 0 && ln === line.number && closes > 0 && opens > 0) return null; // one-liner
    }
    return null;
  }

  // \section{…} folds until the next heading of equal or higher rank.
  const sec = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*[{[]/.exec(line.text);
  if (sec) {
    const rank = SECTION_RANK[sec[1]];
    const last = Math.min(doc.lines, line.number + SCAN_CAP);
    let end = null;
    for (let ln = line.number + 1; ln <= last; ln++) {
      const text = doc.line(ln).text;
      const next = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*[{[]/.exec(text);
      if ((next && SECTION_RANK[next[1]] <= rank) || /\\end\{document\}/.test(text)) {
        end = doc.line(ln - 1).to;
        break;
      }
      end = doc.line(ln).to;
    }
    if (end != null && end > line.to) return { from: line.to, to: end };
  }
  return null;
});
