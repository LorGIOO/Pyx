// Context-aware autocompletion: Python inside cells, LaTeX everywhere else.
// Accepting a LaTeX command that takes an argument inserts the braces ready to
// type inside (\subsection → \subsection{▮}), TeXstudio/VSCode-style, via
// CodeMirror snippet completions (${} marks where the cursor lands).
import { snippetCompletion } from '@codemirror/autocomplete';
import { parseCells } from './cell-parse.js';
import { analyzePython } from './py-deps.js';
import { kernelComplete } from './cell-runner.js';
import { state as appState } from '../core/state.js';
import { dirOf, joinPath } from '../core/paths.js';
import { getDocContent } from './setup.js';
import { readTextFile } from '../core/platform.js';

// Commands that wrap ONE argument in braces → \cmd{▮}.
const ARG1 = [
  'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'chapter', 'part',
  'title', 'author', 'date',
  'textbf', 'textit', 'texttt', 'emph', 'underline', 'textsc', 'textsf', 'textrm', 'textnormal',
  'textsuperscript', 'textsubscript', 'sout', 'uline',
  'label', 'ref', 'eqref', 'pageref', 'autoref', 'cref', 'cite', 'footnote', 'caption', 'index',
  'input', 'include', 'mathbf', 'mathrm', 'mathit', 'mathcal', 'mathbb', 'mathfrak', 'mathsf',
  'text', 'sqrt', 'py', 'pyfile', 'url', 'hat', 'bar', 'vec', 'tilde', 'dot', 'overline',
  'bibliography', 'bibliographystyle', 'pagestyle', 'thispagestyle', 'hspace', 'vspace', 'color',
];
// Commands with TWO arguments → \cmd{▮}{}.
const ARG2 = ['frac', 'dfrac', 'tfrac', 'binom', 'stackrel', 'overset', 'underset', 'newcommand', 'renewcommand'];
// Commands with an optional [..] then a brace → \cmd[▮]{}.
const OPT1 = ['usepackage', 'documentclass', 'includegraphics', 'href'];
// Plain commands (no argument).
const NOARG = [
  'maketitle', 'tableofcontents', 'centering', 'newpage', 'clearpage', 'item', 'hline',
  'toprule', 'midrule', 'bottomrule', 'textbackslash', 'sum', 'prod', 'int', 'lim', 'infty',
  'partial', 'nabla', 'cdot', 'times', 'leq', 'geq', 'neq', 'approx', 'rightarrow', 'Rightarrow',
  'left', 'right', 'quad', 'qquad', 'noindent', 'par', 'bigskip', 'medskip', 'smallskip',
  'alpha', 'beta', 'gamma', 'delta', 'theta', 'lambda', 'mu', 'pi', 'sigma', 'omega', 'phi',
];
const LATEX_ENVS = ['document', 'itemize', 'enumerate', 'figure', 'table', 'tabular', 'equation',
  'align', 'center', 'verbatim', 'quote', 'cases', 'matrix', 'pmatrix', 'bmatrix'];

function latexCmd(name) {
  const lbl = '\\' + name;
  if (ARG2.includes(name)) return snippetCompletion(`${lbl}{\${}}{}`, { label: lbl, type: 'function' });
  if (OPT1.includes(name)) return snippetCompletion(`${lbl}{\${}}`, { label: lbl, type: 'keyword' });
  if (ARG1.includes(name)) return snippetCompletion(`${lbl}{\${}}`, { label: lbl, type: 'keyword' });
  return { label: lbl, type: 'keyword' };
}
function latexEnv(env) {
  // \begin{env} expands the whole environment with the cursor inside.
  return snippetCompletion(`\\begin{${env}}\n\t\${}\n\\end{${env}}`, {
    label: '\\begin{' + env + '}', type: 'class',
  });
}

// First/primary \begin option: a GENERIC environment where YOU type the name,
// and \end mirrors it automatically (linked ${1}). Listed before the predefined
// environments so you can always introduce a custom one.
const beginGeneric = snippetCompletion('\\begin{${1:entorno}}\n\t${2}\n\\end{${1}}', {
  label: '\\begin{ }', detail: 'entorno personalizado (escribe el nombre)', type: 'class', boost: 60,
});
const latexOptions = [
  beginGeneric,
  ...[...ARG1, ...ARG2, ...OPT1, ...NOARG].map(latexCmd),
  ...LATEX_ENVS.map(latexEnv),
];

// A function completion that inserts `name()` and drops the caret INSIDE the
// parens (VSCode/Jupyter behaviour), so calling is one keypress.
const pyFunc = (name, detail) =>
  snippetCompletion(`${name}(\${})`, { label: name, type: 'function', detail });

// VSCode/Jupyter-style code snippets: accepting one drops a ready-to-fill
// template — Tab through the ${ } holes — so you don't have to remember Python
// syntax to write a loop, a function or a try/except.
const PY_SNIPPETS = [
  snippetCompletion('for ${item} in ${iterable}:\n\t${}', { label: 'for', detail: 'bucle for', type: 'keyword', boost: 50 }),
  snippetCompletion('for ${i} in range(${n}):\n\t${}', { label: 'forrange', detail: 'for i in range(n)', type: 'keyword', boost: 48 }),
  snippetCompletion('while ${condicion}:\n\t${}', { label: 'while', detail: 'bucle while', type: 'keyword', boost: 50 }),
  snippetCompletion('if ${condicion}:\n\t${}', { label: 'if', detail: 'condición', type: 'keyword', boost: 50 }),
  snippetCompletion('if ${condicion}:\n\t${}\nelse:\n\t', { label: 'ifelse', detail: 'si … si no', type: 'keyword', boost: 48 }),
  snippetCompletion('elif ${condicion}:\n\t${}', { label: 'elif', detail: 'si no, si …', type: 'keyword', boost: 47 }),
  snippetCompletion('def ${nombre}(${args}):\n\t${}', { label: 'def', detail: 'definir función', type: 'keyword', boost: 50 }),
  snippetCompletion('class ${Nombre}:\n\tdef __init__(self, ${args}):\n\t\t${}', { label: 'class', detail: 'definir clase', type: 'keyword', boost: 48 }),
  snippetCompletion('with ${expr} as ${nombre}:\n\t${}', { label: 'with', detail: 'gestor de contexto', type: 'keyword', boost: 47 }),
  snippetCompletion('try:\n\t${}\nexcept ${Exception} as e:\n\t', { label: 'try', detail: 'try / except', type: 'keyword', boost: 47 }),
  snippetCompletion('import ${modulo}', { label: 'import', detail: 'importar', type: 'keyword', boost: 46 }),
  snippetCompletion('from ${modulo} import ${nombre}', { label: 'from', detail: 'from … import', type: 'keyword', boost: 46 }),
  snippetCompletion('lambda ${x}: ${expr}', { label: 'lambda', detail: 'función anónima', type: 'keyword', boost: 40 }),
  pyFunc('print', 'imprimir'),
];
// Without a kernel (or while it is busy): keywords, builtins and the names
// the document's cells define. With one, jedi answers instead (see below).
const PY_KEYWORDS = ['as', 'else', 'except', 'finally', 'return', 'yield', 'in', 'is', 'not', 'and',
  'or', 'pass', 'break', 'continue', 'global', 'nonlocal', 'async', 'await', 'raise', 'assert', 'del',
  'None', 'True', 'False'];
const PY_BUILTINS = ['len', 'range', 'abs', 'sum', 'min', 'max', 'round', 'enumerate', 'zip', 'map',
  'filter', 'sorted', 'reversed', 'open', 'isinstance', 'format', 'repr', 'any', 'all', 'int', 'float',
  'str', 'list', 'dict', 'set', 'tuple', 'bool', 'complex'];
const pyStatic = [
  ...PY_KEYWORDS.map((k) => ({ label: k, type: 'keyword' })),
  ...PY_BUILTINS.map((b) => pyFunc(b)),
];

function inCell(state, pos) {
  const ln = state.doc.lineAt(pos).number;
  return parseCells(state).some((c) => ln > c.headerLine && ln < c.endLine);
}

/* ---------- context-aware argument completions (refs, cites, envs) ---------- */
const REF_CMDS = 'ref|eqref|pageref|autoref|cref|Cref|vref|nameref|labelcref';
const CITE_CMDS = 'cite|citep|citet|citeauthor|citeyear|textcite|parencite|footcite|nocite|citealt|citealp|autocite';
const reRef = new RegExp(`\\\\(?:${REF_CMDS})\\{([^}]*)$`);
const reCite = new RegExp(`\\\\(?:${CITE_CMDS})\\{([^}]*)$`);
const reEnv = /\\(begin|end)\{([a-zA-Z*]*)$/;
const rePy = /\\py\{([\w.]*)$/; // \py{ → live kernel variable names


// All open text documents joined (master + children), so labels/bib defined in
// any open file are offered.
function allOpenText() {
  const parts = [];
  for (const d of appState.documents) {
    if (d.kind) continue;
    try { parts.push(getDocContent(d.id) || ''); } catch (_) { /* not mounted */ }
  }
  return parts.join('\n');
}

let labelCache = { sig: -1, opts: [] };
function labelOptions() {
  const text = allOpenText();
  if (labelCache.sig === text.length) return labelCache.opts;
  const set = new Set();
  const re = /\\label\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(text))) set.add(m[1]);
  labelCache = { sig: text.length, opts: [...set].map((k) => ({ label: k, type: 'property' })) };
  return labelCache.opts;
}

let bibCache = { key: '', t: 0, opts: [] };
async function bibOptions() {
  const text = allOpenText();
  const res = new Set();
  let m;
  const reAdd = /\\addbibresource\{([^}]+)\}/g;
  while ((m = reAdd.exec(text))) res.add(m[1].trim());
  const reBib = /\\bibliography\{([^}]+)\}/g;
  while ((m = reBib.exec(text))) for (const part of m[1].split(',')) res.add(part.trim());
  const active = appState.documents[appState.activeIndex];
  const dir = dirOf(active && active.path);
  const files = [];
  for (const r of res) {
    const name = /\.bib$/i.test(r) ? r : r + '.bib';
    files.push(/^[a-zA-Z]:[\\/]/.test(name) ? name : (dir ? joinPath(dir, name) : name));
  }
  // Keys from any OPEN .bib documents too.
  let openBib = '';
  for (const d of appState.documents) {
    if (!d.kind && /\.bib$/i.test(d.fileName || '')) {
      try { openBib += '\n' + (getDocContent(d.id) || ''); } catch (_) { /* ignore */ }
    }
  }
  const cacheKey = files.join('|') + '#' + openBib.length;
  if (bibCache.key === cacheKey && Date.now() - bibCache.t < 15000) return bibCache.opts;
  let bibText = openBib;
  for (const f of files) {
    try { bibText += '\n' + (await readTextFile(f)); } catch (_) { /* missing .bib */ }
  }
  const set = new Set();
  const re = /@\s*[a-zA-Z]+\s*\{\s*([^,\s}]+)/g;
  while ((m = re.exec(bibText))) if (m[1].toLowerCase() !== 'string') set.add(m[1]);
  bibCache = { key: cacheKey, t: Date.now(), opts: [...set].map((k) => ({ label: k, type: 'property' })) };
  return bibCache.opts;
}

const COMMON_ENVS = ['itemize', 'enumerate', 'description', 'figure', 'figure*', 'table', 'table*',
  'tabular', 'tabularx', 'equation', 'equation*', 'align', 'align*', 'gather', 'multline', 'center',
  'flushleft', 'flushright', 'quote', 'quotation', 'verbatim', 'lstlisting', 'minipage', 'cases',
  'matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'array', 'theorem', 'lemma', 'proof', 'definition',
  'abstract', 'thebibliography', 'frame'];
function envNames() {
  const set = new Set(COMMON_ENVS);
  const re = /\\begin\{([a-zA-Z*]+)\}/g;
  const text = allOpenText();
  let m;
  while ((m = re.exec(text))) set.add(m[1]);
  return [...set];
}
// The editor auto-closes the brace; if a `}` follows the cursor, consume it so
// the completion doesn't leave a double `}`.
function consumeBrace(view, to) {
  return view.state.doc.sliceString(to, to + 1) === '}' ? to + 1 : to;
}
// Picking a predefined \begin{NAME} also opens the body and adds \end{NAME}.
function beginApply(env) {
  return (view, c, from, to) => {
    const end = consumeBrace(view, to);
    const line = view.state.doc.lineAt(from);
    const indent = (line.text.match(/^[ \t]*/) || [''])[0];
    const head = `${env}}`;
    const body = `\n${indent}\t`;
    const insert = head + body + `\n${indent}\\end{${env}}`;
    view.dispatch({ changes: { from, to: end, insert }, selection: { anchor: from + head.length + body.length } });
  };
}
function endApply(env) {
  return (view, c, from, to) => {
    const end = consumeBrace(view, to);
    const insert = `${env}}`;
    view.dispatch({ changes: { from, to: end, insert }, selection: { anchor: from + insert.length } });
  };
}
// FIRST option in every \begin{/\end{ list: type the name freely (clears the
// partial, leaves the cursor between the braces). "{ … }".
const freeEnvOption = {
  label: '{ … }', detail: 'escribir el nombre', type: 'text', boost: 99,
  apply: (view, c, from, to) => view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } }),
};
function beginEnvOptions() {
  return [freeEnvOption, ...envNames().map((e) => ({ label: e, type: 'class', apply: beginApply(e) }))];
}
function endEnvOptions() {
  return [freeEnvOption, ...envNames().map((e) => ({ label: e, type: 'class', apply: endApply(e) }))];
}

/* ---------- Python: real completion (jedi) ---------- */
// Names DEFINED by the document's cells (variables, functions, imports), from
// the same analysis the dependency graph uses.
function docDefinedNames(state) {
  const names = new Set();
  for (const c of parseCells(state)) for (const d of analyzePython(c.code).defs) names.add(d);
  return names;
}

// The code jedi sees: every cell above (so a name defined there but not run
// yet still completes) and the current cell, with the cursor's line/column.
function cellSource(state, pos) {
  const ln = state.doc.lineAt(pos).number;
  const parts = [];
  for (const c of parseCells(state)) {
    if (ln > c.headerLine && ln < c.endLine) {
      const offset = parts.reduce((n, p) => n + p.split('\n').length, 0);
      parts.push(c.code);
      return { code: parts.join('\n'), line: offset + (ln - c.headerLine), col: pos - state.doc.lineAt(pos).from };
    }
    if (c.headerLine > ln) break;
    parts.push(c.code);
  }
  return null;
}

async function activeCwdQuick() {
  try {
    const m = await import('../compile/compiler.js');
    return await m.activeRootDir();
  } catch (_) {
    return undefined;
  }
}

const JEDI_BOOST = { variable: 20, function: 15, class: 15, namespace: 10, property: 12, keyword: 0, text: 25 };
function jediOption(item) {
  const call = (item.type === 'function' || item.type === 'class') && !item.name.endsWith('=');
  const detail = item.module && item.type !== 'keyword' ? item.module : undefined;
  if (call) return snippetCompletion(`${item.name}(\${})`, { label: item.name, type: item.type, detail, boost: JEDI_BOOST[item.type] });
  return { label: item.name, type: item.type, detail, boost: JEDI_BOOST[item.type] || 0 };
}

async function pythonCompletions(context) {
  const { state, pos } = context;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const afterDot = /\.\w*$/.test(before);
  const inString = /(['"])[^'"]*$/.test(before);
  const word = context.matchBefore(/[A-Za-z_]\w*/);
  if (!context.explicit && !afterDot && !inString && (!word || word.from === word.to)) return null;

  const src = cellSource(state, pos);
  const res = src ? await kernelComplete(src.code, src.line, src.col, await activeCwdQuick()) : null;
  if (context.aborted) return null;
  if (res && res.items.length) {
    // jedi says how much of each name is already typed: name minus `complete`.
    const first = res.items[0];
    const typed = Math.max(0, first.name.length - first.complete.length);
    const options = res.items.map(jediOption);
    if (!afterDot && !inString) options.push(...PY_SNIPPETS);
    return { from: pos - typed, options, validFor: inString ? undefined : /^\w*$/ };
  }
  if (afterDot || inString) return null; // nothing reliable to say about attributes
  if (!word) return null;
  const opts = [...PY_SNIPPETS, ...pyStatic];
  const seen = new Set(opts.map((o) => o.label));
  for (const n of docDefinedNames(state)) if (!seen.has(n)) { seen.add(n); opts.push({ label: n, type: 'variable', boost: 30 }); }
  return { from: word.from, options: opts, validFor: /^\w*$/ };
}

export { cellSource };

export async function calcCompletions(context) {
  if (inCell(context.state, context.pos)) return pythonCompletions(context);

  // Inside a \ref{…}/\cite{…}/\begin{…} argument → suggest the right list.
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  let m;
  if ((m = before.match(reRef))) {
    return { from: context.pos - m[1].length, options: labelOptions(), validFor: /^[^}]*$/ };
  }
  if ((m = before.match(reCite))) {
    const frag = m[1].split(',').pop(); // complete the key after the last comma
    return { from: context.pos - frag.length, options: await bibOptions(), validFor: /^[^},]*$/ };
  }
  if ((m = before.match(reEnv))) {
    const partial = m[2];
    const opts = m[1] === 'begin' ? beginEnvOptions() : endEnvOptions();
    return { from: context.pos - partial.length, options: opts, validFor: /^[a-zA-Z*]*$/ };
  }
  if ((m = before.match(rePy))) {
    const names = [...docDefinedNames(context.state)];
    if (names.length) {
      return {
        from: context.pos - m[1].length,
        options: names.map((n) => ({ label: n, type: 'variable' })),
        validFor: /^[\w.]*$/,
      };
    }
  }

  // Otherwise: complete a command after a backslash.
  const cmd = context.matchBefore(/\\[a-zA-Z]*/);
  if (!cmd) return null;
  return { from: cmd.from, options: latexOptions, validFor: /^\\[a-zA-Z]*$/ };
}
