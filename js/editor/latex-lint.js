// Live LaTeX diagnostics, while you type — before any compile.
//
// The checks are the ones texlab (github.com/latex-lsp/texlab, the LaTeX
// language server) runs on its own syntax tree, re-implemented here as a
// single pass over the text (texlab is GPL-3; this is written from its
// documented behaviour, not from its code):
//
//   - braces that never close, or close nothing;
//   - \begin{x} … \end{y} that do not pair up (and the environment that was
//     never closed — including a missing \end{document});
//   - a \label defined twice;
//   - a \ref to a label that does not exist (only when the file is the whole
//     document: with \input chapters the label may live in another file);
//   - inline math opened with $ and not closed by the end of the paragraph.
//
// Every one of these is an error LaTeX reports much later, after a compile,
// usually with a line number pointing somewhere else ("Runaway argument",
// "File ended while scanning…", "\begin{itemize} ended by \end{document}").
// Underlining it the moment it is typed is the whole point.
//
// What is NOT LaTeX is skipped: Python cells (%#python … %#end), comments,
// verbatim environments, \verb|…| and \lstinline, and the Python inside
// \py{…} / \pyif{…}.

const VERBATIM = new Set([
  'verbatim', 'Verbatim', 'BVerbatim', 'LVerbatim', 'lstlisting', 'minted',
  'alltt', 'comment', 'filecontents', 'filecontents*', 'verbatim*',
]);
const REF_CMDS = new Set(['ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref', 'nameref', 'vref', 'Vref', 'cpageref']);
const CODE_ARG_CMDS = new Set(['py', 'pyif', 'url', 'href', 'path']);
const MULTI_FILE = /\\(?:input|include|subfile|import|subimport|includefrom)\s*[{[]/;

const ES = (es) => es;

/**
 * @param {string} text
 * @param {(es: string, en: string) => string} [tr]  translator
 * @returns {{from:number,to:number,severity:'error'|'warning'|'info',message:string,rule:string}[]}
 */
export function lintLatex(text, tr = ES) {
  const diags = [];
  // Verbatim environments the document defines for itself: their content is
  // code, not LaTeX, exactly like lstlisting's.
  const verbatim = new Set(VERBATIM);
  for (const m of text.matchAll(/\\(?:lstnewenvironment|DefineVerbatimEnvironment|newtcblisting|NewTCBListing|newtcbinputlisting)\s*\{([^}]+)\}/g)) {
    verbatim.add(m[1].trim());
  }
  for (const m of text.matchAll(/\\newminted\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g)) {
    verbatim.add(m[1] ? m[1].trim() : `${m[2].trim()}code`);
  }
  const add = (from, to, severity, rule, es, en) =>
    diags.push({ from, to: Math.max(from + 1, to), severity, rule, message: tr(es, en) });

  const braces = [];            // { pos, code }  — code: argument of \py{…} etc.
  const envs = [];              // { name, from, to }
  const labels = new Map();     // name -> [from, to]
  const refs = [];              // { name, from, to }
  let mathOpen = null;          // position of the $ that opened inline math
  let displayDollar = null;     // position of an open $$
  let verbEnv = null;           // name of the verbatim env we are inside
  let inCell = false;
  let codeDepth = 0;            // > 0 while inside \py{…} and friends
  let pendingCode = false;      // the next { opens a code argument
  let hasCells = false;
  let topClass = false;         // a \documentclass of its own, outside any env
  const n = text.length;

  const closeParagraph = () => {
    if (mathOpen !== null) {
      add(mathOpen, mathOpen + 1, 'warning', 'math',
        'Fórmula abierta con $ que no se cierra antes del fin del párrafo.',
        'Math opened with $ is not closed before the end of the paragraph.');
      mathOpen = null;
    }
  };

  let lineStart = 0;
  while (lineStart <= n) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = n;
    const line = text.slice(lineStart, lineEnd);
    const trimmed = line.trim();

    // ---- Python cells: not LaTeX at all ----
    if (inCell) {
      if (trimmed.startsWith('%#end')) inCell = false;
      lineStart = lineEnd + 1;
      continue;
    }
    if (!verbEnv && trimmed.startsWith('%#python')) {
      inCell = true;
      hasCells = true;
      lineStart = lineEnd + 1;
      continue;
    }
    if (!verbEnv && trimmed === '') closeParagraph();

    let i = 0;
    while (i < line.length) {
      const pos = lineStart + i;
      // ---- inside a verbatim environment: only its \end matters ----
      if (verbEnv) {
        const at = line.indexOf('\\end', i);
        if (at < 0) break;
        const m = /^\\end\s*\{([^}]*)\}/.exec(line.slice(at));
        if (m && m[1] === verbEnv) {
          const top = envs[envs.length - 1];
          if (top && top.name === verbEnv) envs.pop();
          verbEnv = null;
          i = at + m[0].length;
        } else {
          i = at + 4;
        }
        continue;
      }
      const c = line[i];
      // A comment runs to the end of the line — except inside \py{…}, where
      // `%` is Python's modulo (`\py{n % 97}`), as the compiler reads it too.
      if (c === '%' && codeDepth === 0) break;
      if (c === '\\') {
        const next = line[i + 1];
        if (next === undefined) { i++; continue; }
        if (!/[A-Za-z@]/.test(next)) { i += 2; continue; } // \{ \} \$ \% \\ …
        let j = i + 1;
        while (j < line.length && /[A-Za-z@]/.test(line[j])) j++;
        const name = line.slice(i + 1, j);
        // \verb|…| and \lstinline|…|: the delimiter is any character.
        if ((name === 'verb' || name === 'lstinline') && codeDepth === 0) {
          let k = j;
          if (line[k] === '*') k++;
          if (name === 'lstinline' && line[k] === '[') {
            const close = line.indexOf(']', k);
            if (close >= 0) k = close + 1;
          }
          const delim = line[k];
          if (delim === '{') {
            const close = line.indexOf('}', k + 1);
            i = close >= 0 ? close + 1 : line.length;
          } else if (delim) {
            const close = line.indexOf(delim, k + 1);
            i = close >= 0 ? close + 1 : line.length;
          } else {
            i = k;
          }
          continue;
        }
        if (codeDepth === 0 && (name === 'begin' || name === 'end')) {
          const m = /^\s*\{([^{}]*)\}/.exec(line.slice(j));
          if (m) {
            const env = m[1].trim();
            const from = pos, to = lineStart + j + m[0].length;
            if (name === 'begin') {
              envs.push({ name: env, from, to });
              if (verbatim.has(env)) verbEnv = env;
              if (env === 'document') closeParagraph();
            } else {
              closeEnv(env, from, to);
            }
            i = j + m[0].length;
            continue;
          }
        }
        if (codeDepth === 0 && name === 'label') {
          const m = /^\s*\{([^{}]*)\}/.exec(line.slice(j));
          if (m) {
            const key = m[1].trim();
            const from = pos, to = lineStart + j + m[0].length;
            if (labels.has(key)) {
              add(from, to, 'warning', 'label',
                `Etiqueta duplicada: «${key}» ya se definió antes.`,
                `Duplicate label: "${key}" is already defined.`);
            } else {
              labels.set(key, [from, to]);
            }
            i = j + m[0].length;
            continue;
          }
        }
        if (codeDepth === 0 && REF_CMDS.has(name)) {
          const m = /^\*?\s*\{([^{}]*)\}/.exec(line.slice(j));
          if (m) {
            const argFrom = lineStart + j + m[0].indexOf('{') + 1;
            let off = 0;
            for (const part of m[1].split(',')) {
              const key = part.trim();
              const at = argFrom + off + part.indexOf(key);
              if (key) refs.push({ name: key, from: at, to: at + key.length });
              off += part.length + 1;
            }
            i = j + m[0].length;
            continue;
          }
        }
        if (name === 'documentclass' && envs.length === 0 && codeDepth === 0) topClass = true;
        if (CODE_ARG_CMDS.has(name)) pendingCode = true;
        i = j;
        continue;
      }
      if (c === '{') {
        const code = pendingCode || codeDepth > 0;
        braces.push({ pos, code });
        if (code) codeDepth++;
        pendingCode = false;
        i++;
        continue;
      }
      pendingCode = pendingCode && /\s|\[|\]|\*/.test(c) && c !== '}';
      if (c === '}') {
        const open = braces.pop();
        if (!open) {
          add(pos, pos + 1, 'error', 'brace',
            'Llave de cierre «}» que no cierra nada.',
            'Closing brace "}" closes nothing.');
        } else if (open.code) {
          codeDepth--;
        }
        i++;
        continue;
      }
      if (c === '$' && codeDepth === 0) {
        if (line[i + 1] === '$') {
          if (mathOpen === null) displayDollar = displayDollar === null ? pos : null;
          i += 2;
          continue;
        }
        if (displayDollar === null) mathOpen = mathOpen === null ? pos : null;
        i++;
        continue;
      }
      i++;
    }
    if (lineEnd >= n) break;
    lineStart = lineEnd + 1;
  }
  closeParagraph();

  function closeEnv(env, from, to) {
    // The nearest open environment with this name.
    let k = envs.length - 1;
    while (k >= 0 && envs[k].name !== env) k--;
    if (k < 0) {
      add(from, to, 'error', 'env',
        `\\end{${env}} sin su \\begin{${env}}.`,
        `\\end{${env}} without a matching \\begin{${env}}.`);
      return;
    }
    // Everything opened after it and never closed.
    for (let m = envs.length - 1; m > k; m--) {
      const o = envs[m];
      add(o.from, o.to, 'error', 'env',
        `\\begin{${o.name}} no se cierra: falta \\end{${o.name}} antes de \\end{${env}}.`,
        `\\begin{${o.name}} is never closed: \\end{${o.name}} is missing before \\end{${env}}.`);
    }
    envs.length = k;
  }

  for (const o of envs) {
    add(o.from, o.to, 'error', 'env',
      `\\begin{${o.name}} no se cierra: falta \\end{${o.name}}.`,
      `\\begin{${o.name}} is never closed: \\end{${o.name}} is missing.`);
  }
  for (const b of braces) {
    add(b.pos, b.pos + 1, 'error', 'brace',
      'Llave «{» sin cerrar.', 'Unclosed brace "{".');
  }

  // A \ref can only be judged when this file is the whole document — its own
  // \documentclass, no chapters pulled in, no labels borrowed from another
  // document (xr), at least one label of its own — and when no Python cell
  // could be writing labels.
  const standalone = topClass && !MULTI_FILE.test(text)
    && !/\\externaldocument/.test(text) && labels.size > 0;
  const cellsMayLabel = hasCells && /%#python[\s\S]*?\\\\?label/.test(text);
  if (standalone && !cellsMayLabel) {
    for (const r of refs) {
      if (!labels.has(r.name)) {
        add(r.from, r.to, 'warning', 'ref',
          `Referencia a una etiqueta que no existe: «${r.name}».`,
          `Reference to a label that does not exist: "${r.name}".`);
      }
    }
  }
  return diags.sort((a, b) => a.from - b.from);
}

