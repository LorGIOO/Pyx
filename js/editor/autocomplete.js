// Context-aware autocompletion: Python inside cells, LaTeX everywhere else.
// Accepting a LaTeX command that takes an argument inserts the braces ready to
// type inside (\subsection → \subsection{▮}), TeXstudio/VSCode-style, via
// CodeMirror snippet completions (${} marks where the cursor lands).
import { snippetCompletion, snippet, startCompletion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { insertEnvSkeleton, envIsClosed } from './latex-env.js';
import LATEX_DATA from '../data/latex-completions.json';
import { parseCells } from './cell-parse.js';
import { analyzePython } from './py-deps.js';
import { kernelComplete, linkedNames } from './cell-runner.js';
import { notebookRefs, resolveLinkPath, loadNotebook } from './notebooks.js';
import { pyExprBefore } from './py-expr.js';
import { state as appState } from '../core/state.js';
import { dirOf, joinPath } from '../core/paths.js';
import { getDocContent, getDocText } from './setup.js';
import { readTextFile } from '../core/platform.js';

/* ---------- LaTeX commands and environments: from DATA ----------
   js/data/latex-completions.json lists every command and environment the
   editor offers: its arguments as a snippet (${1:marcador} — Tab jumps to the
   next), the package it comes from and a description. Adding a line there is
   all it takes. A command from a package the document does not load yet is
   still offered, after the others — and accepting it adds the \usepackage to
   the preamble (TeXstudio only lists what is loaded; you would have to know
   which package to load first). */
const BASE_PACKAGES = new Set(['']);

/** Packages loaded by the open documents (\usepackage, \RequirePackage, beamer). */
function loadedPackages(text) {
  const set = new Set(BASE_PACKAGES);
  const re = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text))) for (const p of m[1].split(',')) set.add(p.trim());
  if (/\\documentclass\s*(?:\[[^\]]*\])?\s*\{beamer\}/.test(text)) set.add('beamer');
  // What other packages already bring along.
  if (set.has('mathtools')) set.add('amsmath');
  if (set.has('amssymb')) set.add('amsfonts');
  if (set.has('pgfplots')) set.add('tikz');
  if (set.has('beamer')) { set.add('graphicx'); set.add('xcolor'); set.add('hyperref'); set.add('amsmath'); }
  return set;
}

/** Where `\usepackage{pkg}` goes in this document, or -1 (no preamble here). */
function preambleSlot(doc) {
  const text = doc.toString();
  const begin = text.indexOf('\\begin{document}');
  const cls = text.search(/\\documentclass/);
  if (begin < 0 || cls < 0 || cls > begin) return -1;
  const head = text.slice(0, begin);
  const re = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\}[^\n]*\n?/g;
  let last = -1, m;
  while ((m = re.exec(head))) last = m.index + m[0].length;
  if (last >= 0) return last;
  const nl = text.indexOf('\n', cls);
  return nl < 0 ? -1 : nl + 1;
}

/** A completion that also loads its package if the document lacks it. */
function withPackage(template, pkg, info) {
  const base = snippet(template);
  return {
    ...info,
    apply: (view, completion, from, to) => {
      base(view, completion, from, to);
      if (!pkg || loadedPackages(view.state.doc.toString()).has(pkg)) return;
      const at = preambleSlot(view.state.doc);
      if (at < 0 || at > from) return;
      view.dispatch({ changes: { from: at, insert: `\\usepackage{${pkg}}\n` } });
    },
  };
}

function commandOption([name, args, pkg, detail], loaded) {
  const label = '\\' + name;
  const known = loaded.has(pkg);
  const info = {
    label,
    type: args ? 'function' : 'keyword',
    detail: pkg ? `${detail} · ${pkg}${known ? '' : ' (se añade \\usepackage)'}` : detail,
    boost: known ? 0 : -20,
  };
  if (!args && (known || !pkg)) return info;
  return withPackage(label.replace(/\[\]$/, '') + args, known ? '' : pkg, info);
}

function envTemplate([name, args, , , body], indent = '') {
  return `\\begin{${name}}${args}\n${indent}${body}\n${indent}\\end{${name}}`;
}
function envOption(row, loaded) {
  const [name, , pkg, detail] = row;
  const known = loaded.has(pkg);
  return withPackage(envTemplate(row), known ? '' : pkg, {
    label: `\\begin{${name}}`, type: 'class', boost: known ? -5 : -25,
    detail: pkg ? `${detail} · ${pkg}${known ? '' : ' (se añade \\usepackage)'}` : detail,
  });
}

// First/primary \begin option: a GENERIC environment where YOU type the name.
// ONE cursor, in \begin{▮}: the \end follows what you type (the rename filter,
// latex-extras.js) and Enter or Tab step into the body (latex-env.js). It used
// to be a snippet with a linked field — two cursors, which outlived the name:
// Enter split both lines and everything typed afterwards came out twice.
const beginGeneric = {
  label: '\\begin{ }', detail: 'entorno personalizado (escribe el nombre)', type: 'class', boost: 60,
  apply: (view, c, from, to) => {
    insertEnvSkeleton(view, from, to);
    startCompletion(view); // the environment names, for the name being typed
  },
};

/** Commands the documents define themselves (\newcommand, \DeclareMathOperator, \def). */
function userCommands(text) {
  const out = new Map();
  const re = /\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z@]+)\}?\s*(?:\[(\d)\])?(?:\[[^\]]*\])?/g;
  let m;
  while ((m = re.exec(text))) out.set(m[1], +(m[2] || 0));
  const reOp = /\\DeclareMathOperator\*?\s*\{\\([A-Za-z]+)\}/g;
  while ((m = reOp.exec(text))) out.set(m[1], 0);
  const reDef = /\\def\\([A-Za-z@]+)(#\d)*/g;
  while ((m = reDef.exec(text))) if (!out.has(m[1])) out.set(m[1], (m[0].match(/#\d/g) || []).length);
  return out;
}

let latexCache = { text: null, sig: '', opts: [] };
function latexOptions() {
  const text = allOpenText();
  // The very same text as last time (allOpenText hands back the same string
  // while nothing changed): nothing to scan.
  if (latexCache.text === text) return latexCache.opts;
  const loaded = loadedPackages(text);
  const user = userCommands(text);
  const sig = [...loaded].join(',') + '|' + [...user].map(([k, v]) => k + v).join(',');
  if (latexCache.sig === sig) { latexCache.text = text; return latexCache.opts; }
  const known = new Set(LATEX_DATA.commands.map((c) => c[0]));
  const opts = [
    beginGeneric,
    ...LATEX_DATA.commands.map((c) => commandOption(c, loaded)),
    ...LATEX_DATA.environments.map((e) => envOption(e, loaded)),
  ];
  for (const [name, n] of user) {
    if (known.has(name)) continue;
    const args = Array.from({ length: n }, (_, i) => `{\${${i + 1}}}`).join('');
    const info = { label: '\\' + name, type: n ? 'function' : 'keyword', detail: 'definido en el documento', boost: 10 };
    opts.push(n ? snippetCompletion('\\' + name + args, info) : info);
  }
  latexCache = { text, sig, opts };
  return opts;
}

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
const reGls = /\\(?:gls|Gls|GLS|glspl|Glspl|GLSpl|glsdesc|glssymbol|glsname|glstext|acrshort|acrlong|acrfull|Acrshort|Acrlong|Acrfull|ac|Ac|acs|acl|acf|acp|acsp|aclp|acfp)\{([^}]*)$/;

// Glossary entries and acronyms defined in the open documents (and .tex/.bib
// glossary files they open), for \gls{…}.
function glossaryOptions() {
  const text = allOpenText();
  const out = new Map();
  let m;
  const reEntry = /\\newglossaryentry\s*\{([^}]+)\}\s*\{([^]*?)\}\s*$/gm;
  while ((m = reEntry.exec(text))) {
    const name = (/name\s*=\s*\{?([^,}]+)/.exec(m[2]) || [])[1];
    out.set(m[1].trim(), name ? `glosario: ${name.trim()}` : 'glosario');
  }
  const reSimple = /\\newglossaryentry\s*\{([^}]+)\}/g;
  while ((m = reSimple.exec(text))) if (!out.has(m[1].trim())) out.set(m[1].trim(), 'glosario');
  const reAcr = /\\(?:newacronym|DeclareAcronym)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}\s*(?:\{([^}]*)\})?/g;
  while ((m = reAcr.exec(text))) out.set(m[1].trim(), m[2] ? `sigla: ${m[2]}` : 'sigla');
  return [...out].map(([label, detail]) => ({ label, detail, type: 'constant' }));
}


// All open text documents joined (master + children), so labels/bib defined in
// any open file are offered.
//
// Rebuilt only when it has to be. Every `\` typed asked for this — and each
// request turned EVERY open document into a string and joined them, then ran
// the package / \newcommand scans over the result: ~25 ms per backslash with
// a large project open, on the key press. Now:
//   * a document is stringified once per VERSION (CodeMirror's Text is
//     immutable, so the object itself is the cache key), and the join is
//     reused while no document changed;
//   * while typing, the joined text may be up to a second and a half old.
//     These are suggestion lists: a command defined one second ago shows up
//     on the next `\`, which nobody can tell from instantly.
const TEXT_MAX_AGE_MS = 1500;
const stringOf = new WeakMap(); // Text -> its string
let joined = { docs: [], text: '', at: 0 };
function allOpenText() {
  const docs = [];
  for (const d of appState.documents) {
    if (d.kind) continue;
    try {
      const t = getDocText(d.id);
      if (t) docs.push(t);
    } catch (_) { /* not mounted */ }
  }
  const same = docs.length === joined.docs.length && docs.every((t, i) => t === joined.docs[i]);
  if (same) return joined.text;
  // Same set of documents, one of them edited a moment ago: still good enough.
  if (docs.length === joined.docs.length && Date.now() - joined.at < TEXT_MAX_AGE_MS) return joined.text;
  const parts = docs.map((t) => {
    let s = stringOf.get(t);
    if (s === undefined) { s = t.toString(); stringOf.set(t, s); }
    return s;
  });
  joined = { docs, text: parts.join('\n'), at: Date.now() };
  return joined.text;
}

// Keyed by the text itself. It was keyed by the text's LENGTH: renaming a
// label to another of the same length (eq:aa → eq:zz), or any edit that left
// the size unchanged, kept offering the old labels.
let labelCache = { text: null, opts: [] };
function labelOptions() {
  const text = allOpenText();
  if (labelCache.text === text) return labelCache.opts;
  const set = new Set();
  const re = /\\label\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(text))) set.add(m[1]);
  labelCache = { text, opts: [...set].map((k) => ({ label: k, type: 'property' })) };
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
    // Absolute: a drive, a network share (\\servidor\…, //servidor/…) or a
    // POSIX root. A share used to count as relative and was glued onto the
    // document's folder, so the keys of a .bib on the server were never found.
    files.push(/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(name) ? name : (dir ? joinPath(dir, name) : name));
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

function envNames() {
  const set = new Set(LATEX_DATA.environments.map((e) => e[0]));
  const re = /\\(?:begin|newenvironment|newtheorem)\{([a-zA-Z*]+)\}/g;
  const text = allOpenText();
  let m;
  while ((m = re.exec(text))) set.add(m[1]);
  return [...set];
}
const ENV_ROWS = new Map(LATEX_DATA.environments.map((e) => [e[0], e]));
// The editor auto-closes the brace; if a `}` follows the cursor, consume it so
// the completion doesn't leave a double `}`.
function consumeBrace(view, to) {
  return view.state.doc.sliceString(to, to + 1) === '}' ? to + 1 : to;
}
// Picking a \begin{NAME} also opens the body and adds \end{NAME} — with the
// arguments and body the data file gives it (a table's column spec, a
// figure's \includegraphics and \caption…), Tab moving between them.
//
// When that \begin is already closed (renaming an existing environment, or
// the generic "\begin{ }" skeleton), only the NAME changes — the \end follows
// through the rename filter. Inserting the whole template there added a
// second \end{NAME}.
function beginApply(env) {
  const row = ENV_ROWS.get(env) || [env, '', '', '', '\t${}'];
  const tpl = envTemplate(row).slice('\\begin{'.length);
  const base = snippet(tpl);
  return (view, c, from, to) => {
    const line = view.state.doc.lineAt(from);
    const close = line.text.indexOf('}', to - line.from);
    if (close >= 0) {
      const nameTo = line.from + close;
      const oldName = view.state.doc.sliceString(from, nameTo);
      if (/^[A-Za-z*@]*$/.test(oldName) && envIsClosed(view.state.doc.toString(), nameTo + 1, oldName)) {
        // Still the empty "\begin{ }" skeleton (a blank body line, then its
        // \end): replace it whole with this environment's template, so a
        // figure still brings its \includegraphics and \caption.
        const doc = view.state.doc;
        const body = line.number + 2 <= doc.lines ? doc.line(line.number + 1) : null;
        const endLine = body ? doc.line(line.number + 2) : null;
        if (line.text.slice(close + 1).trim() === '' && body && body.text.trim() === ''
          && endLine.text.trim() === `\\end{${oldName}}`) {
          base(view, c, from, endLine.to);
          return;
        }
        // An environment with content: only the name changes.
        view.dispatch({
          changes: { from, to: nameTo, insert: env },
          selection: { anchor: nameTo + env.length - oldName.length + 1 }, // past the `}`
          userEvent: 'input.complete',
        });
        return;
      }
    }
    base(view, c, from, consumeBrace(view, to));
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

/* ---------- inside \py{…} / \pyif{…}: the variables there are ----------
   Typing in \py{ lists every variable the document can use there — its own
   cells' and those of the notebooks and .py files it links (\pynotebook,
   \pyfile), what they define in their code and what their live Jupyter kernel
   or saved values hold — exactly as in a cell. After a dot, the attributes of
   the live value (jedi). Works anywhere in the expression, not only right
   after the brace: \py{filas_ln(rumbo_▮ completes too. */

const linkedStatic = new Map(); // notebook path -> { cells, names: Map }
async function linkedFileNames(state) {
  const out = new Map(); // name -> detail
  const refs = notebookRefs(state.doc.toString());
  if (!refs.length) return out;
  const root = await activeCwdQuick();
  for (const ref of refs) {
    const own = appState.documents[appState.activeIndex];
    const p = await resolveLinkPath(root, ref.raw, ref.cmd, own && own.path ? dirOf(own.path) : null);
    if (!p) continue;
    const file = p.split(/[\\/]/).pop();
    try {
      const cells = await loadNotebook(p);
      let hit = linkedStatic.get(p);
      if (!hit || hit.cells !== cells) {
        const names = new Map();
        for (const c of cells) for (const d of analyzePython(c.code).defs) names.set(d, file);
        hit = { cells, names };
        linkedStatic.set(p, hit);
      }
      for (const [n, f] of hit.names) if (!out.has(n)) out.set(n, f);
    } catch (_) { /* unreadable: nothing from it */ }
    try {
      const live = await linkedNames(p);
      for (const [n, t] of Object.entries(live || {})) if (!out.has(n)) out.set(n, t ? `${file} · ${t}` : file);
    } catch (_) { /* no kernel */ }
  }
  return out;
}

async function pyExprCompletions(context, expr) {
  const { pos } = context;
  const word = /[A-Za-z_]\w*$/.exec(expr);
  const typed = word ? word[0] : '';
  const afterDot = /\.\s*[A-Za-z_]?\w*$/.test(expr) && /\.\w*$/.test(expr);
  if (afterDot) {
    // Attributes: jedi on the live value (the kernel's namespace).
    const res = await kernelComplete(expr, 1, expr.length, await activeCwdQuick());
    if (context.aborted || !res || !res.items.length) return null;
    const first = res.items[0];
    const done = Math.max(0, first.name.length - first.complete.length);
    return { from: pos - done, options: res.items.map(jediOption), validFor: /^\w*$/ };
  }
  if (!typed && !context.explicit && !/[({,[\s]$|^$/.test(expr)) return null;
  const opts = new Map();
  for (const n of docDefinedNames(context.state)) opts.set(n, { label: n, type: 'variable', detail: 'documento', boost: 40 });
  for (const [n, detail] of await linkedFileNames(context.state)) {
    if (!opts.has(n)) opts.set(n, { label: n, type: /función|function/.test(detail) ? 'function' : 'variable', detail, boost: 35 });
  }
  if (context.aborted) return null;
  // What the live namespace holds too (names run in this session).
  const res = await kernelComplete(expr, 1, expr.length, await activeCwdQuick());
  if (res && res.items.length) {
    for (const it of res.items) {
      // Dunders and jedi's own interpreter names only when asked for (`\py{_`).
      if (opts.has(it.name) || it.type === 'keyword' || (it.name.startsWith('_') && !typed.startsWith('_'))
        || /^jedi\b/.test(it.module || '')) continue;
      opts.set(it.name, jediOption(it));
    }
  }
  if (!opts.size) return null;
  return { from: pos - typed.length, options: [...opts.values()], validFor: /^\w*$/ };
}

export async function calcCompletions(context) {
  if (inCell(context.state, context.pos)) return pythonCompletions(context);

  // Inside a \ref{…}/\cite{…}/\begin{…} argument → suggest the right list.
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  let m;
  if ((m = before.match(reRef))) {
    return { from: context.pos - m[1].length, options: labelOptions(), validFor: /^[^}]*$/ };
  }
  if ((m = before.match(reGls))) {
    return { from: context.pos - m[1].length, options: glossaryOptions(), validFor: /^[^}]*$/ };
  }
  if ((m = before.match(reCite))) {
    const frag = m[1].split(',').pop(); // complete the key after the last comma
    return { from: context.pos - frag.length, options: await bibOptions(), validFor: /^[^},]*$/ };
  }
  if ((m = before.match(reEnv))) {
    const partial = m[2];
    // (The name being typed is in the text too, closed by the auto-brace: not a suggestion.)
    const opts = (m[1] === 'begin' ? beginEnvOptions() : endEnvOptions()).filter((o) => !partial || o.label !== partial);
    return { from: context.pos - partial.length, options: opts, validFor: /^[a-zA-Z*]*$/ };
  }
  const pyExpr = pyExprBefore(before);
  if (pyExpr !== null) {
    const res = await pyExprCompletions(context, pyExpr);
    if (res) return res;
  }

  // Otherwise: complete a command after a backslash.
  const cmd = context.matchBefore(/\\[a-zA-Z]*/);
  if (!cmd) return null;
  return { from: cmd.from, options: latexOptions(), validFor: /^\\[a-zA-Z]*$/ };
}

/* Typing (or completing) `\py{` / `\pyif{` opens the variable list at once,
   the way typing a `.` opens the attributes in a cell. */
export const pyBraceTrigger = EditorView.updateListener.of((u) => {
  if (!u.docChanged || !u.transactions.some((t) => t.isUserEvent('input'))) return;
  const sel = u.state.selection.main;
  if (!sel.empty) return;
  const line = u.state.doc.lineAt(sel.head);
  const before = line.text.slice(Math.max(0, sel.head - line.from - 8), sel.head - line.from);
  if (/\\py(?:if)?\{$/.test(before)) setTimeout(() => startCompletion(u.view), 0);
});
