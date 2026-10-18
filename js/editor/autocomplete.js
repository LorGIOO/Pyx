// Context-aware autocompletion: Python inside cells, LaTeX everywhere else.
// Accepting a LaTeX command that takes an argument inserts the braces ready to
// type inside (\subsection → \subsection{▮}), TeXstudio/VSCode-style, via
// CodeMirror snippet completions (${} marks where the cursor lands).
import { snippetCompletion, snippet } from '@codemirror/autocomplete';
import LATEX_DATA from '../data/latex-completions.json';
import { parseCells } from './cell-parse.js';
import { analyzePython } from './py-deps.js';
import { kernelComplete } from './cell-runner.js';
import { state as appState } from '../core/state.js';
import { dirOf, joinPath } from '../core/paths.js';
import { getDocContent } from './setup.js';
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

// First/primary \begin option: a GENERIC environment where YOU type the name,
// and \end mirrors it automatically (linked ${1}). Listed before the predefined
// environments so you can always introduce a custom one.
const beginGeneric = snippetCompletion('\\begin{${1:entorno}}\n\t${2}\n\\end{${1}}', {
  label: '\\begin{ }', detail: 'entorno personalizado (escribe el nombre)', type: 'class', boost: 60,
});

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

let latexCache = { sig: '', opts: [] };
function latexOptions() {
  const text = allOpenText();
  const loaded = loadedPackages(text);
  const user = userCommands(text);
  const sig = [...loaded].join(',') + '|' + [...user].map(([k, v]) => k + v).join(',');
  if (latexCache.sig === sig) return latexCache.opts;
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
  latexCache = { sig, opts };
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
function beginApply(env) {
  const row = ENV_ROWS.get(env) || [env, '', '', '', '\t${}'];
  const tpl = envTemplate(row).slice('\\begin{'.length);
  const base = snippet(tpl);
  return (view, c, from, to) => base(view, c, from, consumeBrace(view, to));
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
    // (The name being typed is in the text too, closed by the auto-brace: not a suggestion.)
    const opts = (m[1] === 'begin' ? beginEnvOptions() : endEnvOptions()).filter((o) => !partial || o.label !== partial);
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
  return { from: cmd.from, options: latexOptions(), validFor: /^\\[a-zA-Z]*$/ };
}
