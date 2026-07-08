// Parse a LaTeX engine log (+ Pyx cell/\py warnings) into a structured list of
// problems: { severity: 'error'|'warning', message, line|null, file|null }.
// The list powers the clickable "Problemas" view of the compile-log panel
// (TeXstudio-style: click a problem to jump to that source line).

export function parseLatexLog(log) {
  if (!log) return [];
  const out = [];
  const seen = new Set();
  const push = (p) => {
    const key = `${p.severity}|${p.line}|${p.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };

  // 1) Pyx cell / \py{} problems (the "Avisos de Pyx" block before the LaTeX log).
  const pyxIdx = log.indexOf('===== Avisos de Pyx =====');
  if (pyxIdx >= 0) {
    const block = log.slice(pyxIdx).split('\n\n')[0];
    for (const l of block.split('\n')) {
      const m = l.match(/^\[(.+?)\]\s*(.+)$/);
      if (!m) continue;
      // Cell problems may carry the exact document line: "… · línea N".
      const lm = m[1].match(/\s*·\s*línea\s+(\d+)$/);
      push({
        severity: 'error',
        file: null,
        line: lm ? +lm[1] : null,
        message: `${lm ? m[1].slice(0, lm.index) : m[1]} — ${m[2]}`,
      });
    }
  }

  // 2) The LaTeX engine log.
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    // file:line: message   (e.g. "./doc.tex:42: Undefined control sequence")
    let m = ln.match(/^(?:\.\/)?(.+?\.(?:tex|pltx|sty|cls|ltx)):(\d+):\s*(.+)$/i);
    if (m) {
      push({ severity: 'error', file: m[1], line: +m[2], message: m[3].trim().replace(/\.$/, '') });
      continue;
    }

    // Classic TeX error: "! message" — the line shows up later as "l.<N> …".
    if (ln.startsWith('! ')) {
      const message = ln.slice(2).trim().replace(/\.$/, '');
      let line = null;
      for (let j = i + 1; j < Math.min(i + 16, lines.length); j++) {
        const lm = lines[j].match(/^l\.(\d+)[ \t]/);
        if (lm) { line = +lm[1]; break; }
      }
      push({ severity: 'error', file: null, line, message });
      continue;
    }

    // LaTeX / Package / Class Warning … (the "on input line N" may be on the next line).
    m = ln.match(/^(?:LaTeX|Package\s+\S+|Class\s+\S+|pdfTeX|LaTeX Font)\s+Warning:\s*(.+)$/);
    if (m) {
      const lm = (ln + ' ' + (lines[i + 1] || '')).match(/on input line (\d+)/);
      const message = m[1].trim().replace(/\s*on input line \d+\.?$/, '');
      push({ severity: 'warning', file: null, line: lm ? +lm[1] : null, message });
      continue;
    }

    // Overfull / Underfull boxes (typography warnings, at a line range).
    m = ln.match(/^(Overfull|Underfull)\s+\\([hv])box\b.*?\bat lines? (\d+)(?:--(\d+))?/);
    if (m) {
      push({ severity: 'warning', file: null, line: +m[3], message: `${m[1]} \\${m[2]}box` });
      continue;
    }
  }
  return out;
}
