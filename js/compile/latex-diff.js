// «Comparar versiones»: the changes between two versions of a LaTeX document
// as a document — added text in blue, deleted text in red — the way latexdiff
// does it, without Perl or anything to install.
//
// The output is latexdiff's: the NEW document's preamble plus the \DIFadd /
// \DIFdel commands of the chosen style (UNDERLINE, CFONT, CCHANGEBAR, BOLD,
// with latexdiff's own definitions), and the body with the changes marked.
//
// How it stays compilable: the body is read as a tree — environments with
// their contents, commands with their arguments, math, comments, Python cells
// — and compared level by level. Only TEXT (words, inline math, text
// commands such as \textbf{…} or \ref{…}) is ever wrapped in \DIFadd/\DIFdel;
// structure (\section, \item, \\, &, \label…) is kept from the new version,
// and an environment that disappeared goes as a whole, \begin and \end
// together, with its text struck out. Paragraphs are aligned first, then the
// words inside the ones that changed.
//
// Python cells (%#python … %#end) are kept from the new version, so the
// \py{} values are computed as usual, and their changes are listed at the
// end of the document. `flatten` (latexdiff's --flatten) expands \input /
// \include / \subfile before comparing.

/* ---------------- styles (latexdiff's definitions) ---------------- */
export const DIFF_STYLES = ['UNDERLINE', 'CFONT', 'CCHANGEBAR', 'BOLD'];

function preambleOf(style) {
  const common = [
    '%DIF PREAMBLE EXTENSION ADDED BY PYX (latexdiff style ' + style + ')',
    '\\makeatletter',
    '\\@ifpackageloaded{xcolor}{}{\\@ifpackageloaded{color}{}{\\RequirePackage{color}}}',
  ];
  const body = {
    UNDERLINE: [
      '\\@ifpackageloaded{ulem}{}{\\RequirePackage[normalem]{ulem}}',
      // \\uline, not latexdiff's \\uwave: a template that redefines \\ULdepth
      // (common in CVs) breaks the wave but not the line.
      // ulem's own depth register, whatever the document did to \\ULdepth
      // (a CV template redefines it as «2pt», and \\sout then prints it)
      '\\newdimen\\DIF@ULdepth\\DIF@ULdepth=\\maxdimen',
      '\\providecommand{\\DIFadd}[1]{{\\let\\ULdepth\\DIF@ULdepth\\protect\\color{blue}\\uline{#1}}}',
      '\\providecommand{\\DIFdel}[1]{{\\let\\ULdepth\\DIF@ULdepth\\protect\\color{red}\\sout{#1}}}',
    ],
    CFONT: [
      '\\providecommand{\\DIFadd}[1]{{\\protect\\color{blue}\\sffamily #1}}',
      '\\providecommand{\\DIFdel}[1]{{\\protect\\color{red}\\scriptsize #1}}',
    ],
    CCHANGEBAR: [
      '\\@ifpackageloaded{changebar}{}{\\RequirePackage{changebar}}',
      '\\providecommand{\\DIFadd}[1]{\\protect\\cbstart{\\protect\\color{blue}#1}\\protect\\cbend}',
      '\\providecommand{\\DIFdel}[1]{\\protect\\cbdelete{\\protect\\color{red}#1}\\protect\\cbdelete}',
    ],
    BOLD: [
      '\\providecommand{\\DIFadd}[1]{{\\bfseries #1}}',
      '\\providecommand{\\DIFdel}[1]{}',
    ],
  }[style] || [];
  const blocks = style === 'CCHANGEBAR'
    ? ['\\providecommand{\\DIFaddbegin}{\\protect\\cbstart}', '\\providecommand{\\DIFaddend}{\\protect\\cbend}',
      '\\providecommand{\\DIFdelbegin}{\\protect\\cbdelete}', '\\providecommand{\\DIFdelend}{}']
    : ['\\providecommand{\\DIFaddbegin}{}', '\\providecommand{\\DIFaddend}{}',
      '\\providecommand{\\DIFdelbegin}{}', '\\providecommand{\\DIFdelend}{}'];
  return [
    ...common, ...body, ...blocks,
    // A piece of structure (a figure, a table, an equation…) that was added,
    // changed or deleted: a short note where it is (or was).
    '\\providecommand{\\DIFblock}[2]{\\par\\noindent{\\protect\\color{#1}\\small[#2]}\\par}',
    '\\makeatother',
    '%DIF END PREAMBLE EXTENSION',
  ].join('\n');
}

/* ---------------- tokenizer ---------------- */
// Environments compared as one piece (their inside is not text to mark).
const ATOMIC_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*', 'multline', 'multline*',
  'flalign', 'flalign*', 'eqnarray', 'eqnarray*', 'displaymath', 'math', 'split', 'array', 'matrix', 'pmatrix',
  'bmatrix', 'vmatrix', 'cases', 'verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment',
  'tabular', 'tabular*', 'tabularx', 'longtable', 'tabu', 'array', 'tikzpicture', 'pgfpicture', 'axis',
  'figure', 'figure*', 'table', 'table*', 'subfigure', 'wrapfigure', 'picture', 'thebibliography',
]);
// Commands that are text: they may go inside \DIFadd / \DIFdel.
const SAFE_CMDS = new Set([
  'textbf', 'textit', 'emph', 'texttt', 'textsc', 'textsf', 'textrm', 'textmd', 'textup', 'textsl', 'underline',
  'ref', 'eqref', 'pageref', 'cref', 'Cref', 'autoref', 'nameref', 'cite', 'citep', 'citet', 'citeauthor',
  'citeyear', 'parencite', 'textcite', 'autocite', 'si', 'SI', 'num', 'ang', 'unit', 'qty', 'SIrange', 'numrange',
  'LaTeX', 'TeX', 'today', 'ldots', 'dots', 'textbackslash', 'textasciitilde', 'textendash', 'textemdash',
  'py', 'celda', 'textsuperscript', 'textsubscript', 'mbox', 'enquote', 'url', 'href', 'uline',
]);
// Sectioning-like commands whose argument is text: when deleted, the text
// stays visible, struck out.
const TITLE_CMDS = new Set(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph',
  'caption', 'title', 'footnote', 'author', 'date']);
// Commands whose arguments are not text (lengths, names, files, settings).
const NONTEXT_CMDS = new Set(['label', 'vspace', 'hspace', 'includegraphics', 'input', 'include', 'usepackage',
  'setlength', 'addtolength', 'newcommand', 'renewcommand', 'providecommand', 'def', 'hypersetup', 'color',
  'pagestyle', 'thispagestyle', 'bibliography', 'bibliographystyle', 'addbibresource', 'documentclass', 'setcounter',
  'addtocounter', 'newpage', 'clearpage', 'pagebreak', 'linebreak', 'vskip', 'hskip', 'rule', 'raisebox', 'resizebox',
  'scalebox', 'graphicspath', 'geometry', 'titleformat', 'definecolor', 'pynotebook', 'pyfile', 'hoja', 'todo',
  'index', 'nocite', 'pyif', 'cbstart', 'cbend', 'fontsize', 'selectfont']);
// A command's text arguments marked one by one (kind: 'add' / 'del').
function markArgs(tok, kind, stats) {
  return tok.head + tok.args.map((a) => {
    if (a.raw[0] !== '{') return a.ws + a.raw;
    return a.ws + '{' + emitRun(tokenize(a.raw.slice(1, -1)), kind, stats) + '}';
  }).join('');
}

/**
 * Token kinds: 'ws' (spaces, one line break), 'par' (blank line), 'word',
 * 'math' (inline), 'cmd' (with its [..]{..} arguments), 'sym' (\\, &, a lone
 * brace…), 'comment', 'cell' (a Python cell), 'env' (with children), 'aenv'
 * (an atomic environment, raw).
 */
export function tokenize(src) {
  const s = String(src);
  let i = 0;
  const n = s.length;
  const group = (open, close) => { // balanced {…} or […] starting at s[i] === open
    let depth = 0;
    const st = i;
    for (; i < n; i++) {
      const c = s[i];
      if (c === '\\') { i++; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) { i++; return s.slice(st, i); } }
    }
    return s.slice(st);
  };
  const parse = (stopEnv) => {
    const out = [];
    while (i < n) {
      const c = s[i];
      // Python cell: %#python … %#end, whole lines
      if (c === '%' && /^%#python\b/.test(s.slice(i, i + 9)) && (i === 0 || s[i - 1] === '\n')) {
        const m = /\n%#end[^\n]*/.exec(s.slice(i));
        const end = m ? i + m.index + m[0].length : n;
        out.push({ t: 'cell', raw: s.slice(i, end) });
        i = end;
        continue;
      }
      if (c === '%') {
        const e = s.indexOf('\n', i);
        const end = e < 0 ? n : e;
        out.push({ t: 'comment', raw: s.slice(i, end) });
        i = end;
        continue;
      }
      if (/\s/.test(c)) {
        const st = i;
        while (i < n && /\s/.test(s[i])) i++;
        const raw = s.slice(st, i);
        out.push({ t: (raw.match(/\n/g) || []).length >= 2 ? 'par' : 'ws', raw });
        continue;
      }
      if (c === '$') {
        const dbl = s[i + 1] === '$';
        const st = i;
        i += dbl ? 2 : 1;
        while (i < n && !(s[i] === '$' && s[i - 1] !== '\\' && (!dbl || s[i + 1] === '$'))) i++;
        i += dbl ? 2 : 1;
        out.push({ t: dbl ? 'sym' : 'math', raw: s.slice(st, Math.min(i, n)) });
        continue;
      }
      if (c === '\\') {
        const nx = s[i + 1];
        if (nx === '(' || nx === '[') {
          const close = nx === '(' ? '\\)' : '\\]';
          const e = s.indexOf(close, i + 2);
          const end = e < 0 ? n : e + 2;
          out.push({ t: nx === '(' ? 'math' : 'sym', raw: s.slice(i, end) });
          i = end;
          continue;
        }
        if (nx === '\\') { // \\ and \\[2pt]
          const st = i;
          i += 2;
          if (s[i] === '*') i++;
          if (s[i] === '[') group('[', ']');
          out.push({ t: 'sym', raw: s.slice(st, i) });
          continue;
        }
        const m = /^\\([A-Za-z@]+\*?|.)/.exec(s.slice(i, i + 64));
        const name = m ? m[1] : nx;
        if (name === 'begin' || name === 'end') {
          const st = i;
          i += name.length + 1;
          while (s[i] === ' ') i++;
          const arg = s[i] === '{' ? group('{', '}') : '';
          const env = arg.slice(1, -1);
          if (name === 'end') {
            if (stopEnv !== undefined && env === stopEnv) return { out, end: s.slice(st, i) };
            out.push({ t: 'sym', raw: s.slice(st, i) });
            continue;
          }
          // \begin{env}[opts]{args}
          let j = i;
          const rest = () => { while (s[i] === '[' || s[i] === '{') group(s[i], s[i] === '[' ? ']' : '}'); };
          rest();
          const begin = s.slice(st, i);
          if (ATOMIC_ENVS.has(env)) {
            const endTag = new RegExp(`\\\\end\\s*\\{${env.replace(/[*]/g, '\\*')}\\}`);
            const m2 = endTag.exec(s.slice(i));
            const end = m2 ? i + m2.index + m2[0].length : n;
            out.push({ t: 'aenv', name: env, raw: s.slice(st, end) });
            i = end;
            void j;
            continue;
          }
          const inner = parse(env);
          out.push({ t: 'env', name: env, begin, children: inner.out, end: inner.end || '' });
          continue;
        }
        const st = i;
        i += 1 + name.length;
        const head = s.slice(st, i);
        const args = [];
        if (/^[A-Za-z@]/.test(name)) {
          // its arguments: [..] and {..} right after (spaces allowed before {)
          for (;;) {
            let k = i;
            while (s[k] === ' ' || (s[k] === '\n' && s[k + 1] !== '\n' && args.length)) k++;
            if (s[k] === '[' && k === i) { const ws = s.slice(i, k); i = k; args.push({ ws, raw: group('[', ']') }); continue; }
            if (s[k] === '{') { const ws = s.slice(i, k); i = k; args.push({ ws, raw: group('{', '}') }); continue; }
            break;
          }
        }
        const raw = s.slice(st, i);
        const bare = name.replace(/\*$/, '');
        const t = SAFE_CMDS.has(bare) || /^[%&$#_{}~^ ,;!]$/.test(name) ? 'word' : 'cmd';
        out.push({ t, raw, name: bare, head, args });
        continue;
      }
      if (c === '&' || c === '{' || c === '}' || c === '~' && false) {
        if (c === '{') { out.push({ t: 'sym', raw: group('{', '}') }); continue; }
        out.push({ t: 'sym', raw: c });
        i++;
        continue;
      }
      const st = i;
      while (i < n && !/[\s\\$%&{}]/.test(s[i])) i++;
      out.push({ t: 'word', raw: s.slice(st, i) });
    }
    return { out, end: '' };
  };
  return parse(undefined).out;
}

/* ---------------- LCS ---------------- */
const MAX_CELLS = 4e6;
/** Pairs [i, j] of a longest common subsequence of a and b (by key). */
function lcs(a, b, key, preA, preB) {
  const n = a.length, m = b.length;
  if (!n || !m) return [];
  const ka = preA || a.map(key), kb = preB || b.map(key);
  if ((n + 1) * (m + 1) > MAX_CELLS) return greedy(ka, kb);
  const T = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      T[i * (m + 1) + j] = ka[i] === kb[j] ? T[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(T[(i + 1) * (m + 1) + j], T[i * (m + 1) + j + 1]);
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) { pairs.push([i, j]); i++; j++; }
    else if (T[(i + 1) * (m + 1) + j] >= T[i * (m + 1) + j + 1]) i++;
    else j++;
  }
  return pairs;
}
function greedy(ka, kb) { // too big for the table: match in order where keys are equal
  const pairs = [];
  let j = 0;
  for (let i = 0; i < ka.length && j < kb.length; i++) {
    const k = ka[i];
    const f = kb.indexOf(k, j);
    if (f >= 0 && f - j < 200) { pairs.push([i, f]); j = f + 1; }
  }
  return pairs;
}

/* ---------------- emitting ---------------- */
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
function rawOf(tok) {
  if (tok.t === 'env') return tok.begin + tok.children.map(rawOf).join('') + tok.end;
  return tok.raw;
}
const keyOf = (tok) => (tok.t === 'ws' ? ' ' : tok.t === 'par' ? '\n\n' : tok.t === 'env' ? `env:${tok.name}`
  // a command of the document with text arguments matches by name and shape
  : tok.t === 'cmd' && tok.args && tok.args.length && !NONTEXT_CMDS.has(tok.name) ? `cmd:${tok.head}:${tok.args.map((a) => a.raw[0]).join('')}`
    : norm(tok.raw));
const textLike = (tok) => tok.t === 'word' || tok.t === 'math' || tok.t === 'ws';

/** A deleted \py{expr} cannot be computed in the new document: its text. */
function delWord(raw) {
  const m = /^\\py\*?\{([\s\S]*)\}$/.exec(raw);
  if (m) return `\\texttt{${escapeTeX(m[1])}}`;
  return raw;
}

/** Wrap runs of text tokens with `cmd`, keep (add) or drop (del) the rest. */
function emitRun(tokens, kind, stats) {
  let out = '';
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const raw = buf.map((t) => (kind === 'del' ? delWord(t.raw) : t.raw)).join('');
    const lead = raw.match(/^\s*/)[0];
    const trail = raw.match(/\s*$/)[0];
    const core = raw.slice(lead.length, raw.length - trail.length);
    // the spaces of a deleted run are the old text's: the new text has its own
    if (kind === 'del') out += core ? (lead ? ' ' : '') + `\\DIFdel{${core}}` : '';
    else out += core ? `${lead}\\DIFadd{${core}}${trail}` : raw;
    if (core) stats[kind]++;
    buf = [];
  };
  for (const tok of tokens) {
    if (textLike(tok)) { buf.push(tok); continue; }
    flush();
    if (tok.t === 'par') { out += tok.raw; continue; }
    if (tok.t === 'cell') { if (kind === 'add') out += tok.raw; continue; }
    if (tok.t === 'comment') { if (kind === 'add') out += tok.raw; continue; }
    if (tok.t === 'env') {
      out += tok.begin + emitRun(tok.children, kind, stats) + tok.end;
      continue;
    }
    if (tok.t === 'aenv') {
      stats[kind]++;
      if (kind === 'add') out += `\\DIFaddbegin\\DIFblock{blue}{+ ${tok.name}}${tok.raw}\\DIFaddend `;
      else out += `\\DIFdelbegin\\DIFblock{red}{-- ${tok.name}}\\DIFdelend `;
      continue;
    }
    if (tok.t === 'cmd' || tok.t === 'sym') {
      const textArgs = tok.t === 'cmd' && tok.args && tok.args.some((x) => x.raw[0] === '{')
        && !NONTEXT_CMDS.has(tok.name) && !TITLE_CMDS.has(tok.name);
      if (kind === 'add') {
        // a new command of the document's own (\resumeItem{…}): its text marked
        out += textArgs ? markArgs(tok, 'add', stats) : tok.raw;
        continue;
      }
      // deleted: an \item stays (a struck-out item), a title stays as text,
      // a command with text arguments stays with them struck out
      if (tok.name === 'item') { out += tok.raw.replace(/\[[\s\S]*\]$/, ''); continue; }
      if (TITLE_CMDS.has(tok.name)) {
        const m = /\{([\s\S]*)\}\s*$/.exec(tok.raw);
        if (m && m[1].trim()) { out += `\\DIFdel{${m[1]}}`; stats.del++; }
        continue;
      }
      if (textArgs) { out += markArgs(tok, 'del', stats); continue; }
      // anything else (\label, \vspace, \\, &…) disappears with the old text
    }
  }
  flush();
  return out;
}

/** The marked-up body for two token lists (old, new).
 *  Identical pieces are aligned first; in what is left between them, pieces
 *  of the same shape (the same environment, the same command) are paired and
 *  compared inside; the rest is added or deleted. Spaces never anchor the
 *  alignment, so a run of changed words is marked as one run. */
function diffTokens(a, b, stats) {
  let wsA = 0, wsB = 0;
  const exactA = (t) => (t.t === 'ws' ? `\u0000ws${wsA++}` : t.t === 'par' ? '\n\n' : norm(rawOf(t)));
  const exactB = (t) => (t.t === 'ws' ? `\u0001ws${wsB++}` : t.t === 'par' ? '\n\n' : norm(rawOf(t)));
  const ka = a.map(exactA), kb = b.map(exactB);
  const pairs = lcs(a.map((_, k) => k), b.map((_, k) => k), null, ka, kb);
  let out = '';
  let i = 0, j = 0;
  const gap = (pi, pj) => {
    const ga = a.slice(i, pi), gb = b.slice(j, pj);
    if (!ga.length && !gb.length) return;
    // same-shape pieces (an environment, a command of the document)
    const shape = (t) => (t.t === 'env' || (t.t === 'cmd' && t.args && t.args.length) ? keyOf(t) : null);
    const sa = ga.map((t, k) => shape(t) || `\u0002a${k}`), sb = gb.map((t, k) => shape(t) || `\u0003b${k}`);
    const inner = lcs(ga.map((_, k) => k), gb.map((_, k) => k), null, sa, sb);
    let p = 0, q = 0;
    for (const [pa, pb] of inner) {
      out += emitRun(ga.slice(p, pa), 'del', stats) + emitRun(gb.slice(q, pb), 'add', stats);
      out += pairChanged(ga[pa], gb[pb], stats);
      p = pa + 1;
      q = pb + 1;
    }
    out += emitRun(ga.slice(p), 'del', stats) + emitRun(gb.slice(q), 'add', stats);
  };
  for (const [pi, pj] of pairs) {
    gap(pi, pj);
    const y = b[pj];
    out += y.t === 'ws' || y.t === 'par' ? y.raw : rawOf(y);
    i = pi + 1;
    j = pj + 1;
  }
  gap(a.length, b.length);
  return out;
}

/** Two pieces of the same shape whose text differs: compared inside. */
function pairChanged(x, y, stats) {
  if (y.t === 'env') return y.begin + diffBlocks(x.children, y.children, stats) + y.end;
  // Headings and captions travel to the table of contents and the PDF
  // bookmarks, where the marks would break: like latexdiff, the marked text
  // goes in the body and the new plain title in the optional argument.
  const moving = TITLE_CMDS.has(y.name) && !['title', 'author', 'date', 'footnote'].includes(y.name);
  const short = moving && !/\*\s*$/.test(y.head) && y.args[0] && y.args[0].raw[0] === '{' ? `[${y.args[0].raw.slice(1, -1)}]` : '';
  return y.head + short + y.args.map((arg, k) => {
    const old = x.args[k];
    if (arg.raw[0] !== '{' || !old) return arg.ws + arg.raw;
    return arg.ws + '{' + diffBlocks(tokenize(old.raw.slice(1, -1)), tokenize(arg.raw.slice(1, -1)), stats) + '}';
  }).join('');
}

/** Split at paragraph breaks: [[tokens of a paragraph], [par], …]. */
function paragraphs(tokens) {
  const units = [];
  let cur = [];
  for (const t of tokens) {
    if (t.t === 'par') { if (cur.length) units.push(cur); units.push([t]); cur = []; }
    else cur.push(t);
  }
  if (cur.length) units.push(cur);
  return units;
}

/** Paragraphs first; then the words of the paragraphs that changed. */
function diffBlocks(a, b, stats) {
  const ua = paragraphs(a), ub = paragraphs(b);
  const key = (u) => norm(u.map(rawOf).join(''));
  const pairs = lcs(ua, ub, key);
  let out = '';
  let i = 0, j = 0;
  const changed = (pi, pj) => {
    const da = ua.slice(i, pi).filter((u) => u[0].t !== 'par');
    const db = ub.slice(j, pj);
    // pair the changed paragraphs in order; the leftovers are added / deleted
    let k = 0;
    for (const u of db) {
      if (u[0].t === 'par') { out += u[0].raw; continue; }
      if (k < da.length) out += diffTokens(da[k++], u, stats);
      else out += '\\DIFaddbegin ' + emitRun(u, 'add', stats) + '\\DIFaddend ';
    }
    for (; k < da.length; k++) out += '\\DIFdelbegin ' + emitRun(da[k], 'del', stats) + '\\DIFdelend\n\n';
  };
  for (const [pi, pj] of pairs) {
    changed(pi, pj);
    out += ub[pj].map(rawOf).join('');
    i = pi + 1;
    j = pj + 1;
  }
  changed(ua.length, ub.length);
  return out;
}

/* ---------------- Python cells ---------------- */
export function escapeTeX(s) {
  return String(s).replace(/[\\{}$&#^_%~]/g, (c) => ({
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', $: '\\$', '&': '\\&', '#': '\\#',
    '^': '\\textasciicircum{}', _: '\\_', '%': '\\%', '~': '\\textasciitilde{}',
  }[c]));
}
const cellsOf = (text) => [...String(text).matchAll(/(?:^|\n)%#python[^\n]*\n([\s\S]*?)\n%#end/g)].map((m) => m[1]);

const RGB = { red: '0.8,0,0', blue: '0,0,0.8', gray: '0.45,0.45,0.45' }; // plain `color` has no gray
function codeLine(sign, line, color) {
  const lead = line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
  return `\\noindent{\\color[rgb]{${RGB[color]}}\\ttfamily\\small ${sign}\\ ${'\\ '.repeat(lead)}${escapeTeX(line.trimStart())}}\\par`;
}

/** The appendix with what changed in the Python cells ('' when nothing). */
export function pythonCellsAppendix(oldText, newText, { title = 'Cambios en el código Python', cell = 'Celda', added = 'nueva', deleted = 'eliminada', changed = 'modificada' } = {}) {
  const ca = cellsOf(oldText), cb = cellsOf(newText);
  const pairs = lcs(ca, cb, norm);
  const parts = [];
  let i = 0, j = 0;
  const flush = (pi, pj) => {
    const da = ca.slice(i, pi), db = cb.slice(j, pj);
    const k = Math.max(da.length, db.length);
    for (let x = 0; x < k; x++) {
      const o = da[x], nw = db[x];
      const label = `${cell} ${j + x + 1}`;
      const lines = [];
      if (o != null && nw != null) {
        const la = o.split('\n'), lb = nw.split('\n');
        const lp = lcs(la, lb, (l) => l.trimEnd());
        let p = 0, q = 0;
        const emit = (pa, pb) => {
          for (; p < pa; p++) lines.push(codeLine('-', la[p], 'red'));
          for (; q < pb; q++) lines.push(codeLine('+', lb[q], 'blue'));
        };
        for (const [pa, pb] of lp) { emit(pa, pb); lines.push(codeLine(' ', lb[pb], 'gray')); p = pa + 1; q = pb + 1; }
        emit(la.length, lb.length);
        parts.push(`\\par\\medskip\\noindent\\textbf{${label}} (${changed})\\par`, ...lines);
      } else if (nw != null) {
        parts.push(`\\par\\medskip\\noindent\\textbf{${label}} (${added})\\par`, ...nw.split('\n').map((l) => codeLine('+', l, 'blue')));
      } else {
        parts.push(`\\par\\medskip\\noindent\\textbf{${cell}} (${deleted})\\par`, ...o.split('\n').map((l) => codeLine('-', l, 'red')));
      }
    }
  };
  for (const [pi, pj] of pairs) { flush(pi, pj); i = pi + 1; j = pj + 1; }
  flush(ca.length, cb.length);
  if (!parts.length) return '';
  return ['', '%DIF Python cells', `\\clearpage\\section*{${title}}`, ...parts, ''].join('\n');
}

/* ---------------- flatten ---------------- */
/**
 * Expand \input / \include / \subfile (latexdiff --flatten). `read(path)`
 * gives a file's text (or null); paths are relative to `dir`.
 */
export async function flatten(text, dir, read, join, depth = 0) {
  if (depth > 6) return text;
  const re = /(^|[^\\%])\\(input|include|subfile)\s*\{([^{}]+)\}/g;
  let out = '';
  let at = 0;
  let m;
  const src = String(text);
  while ((m = re.exec(src))) {
    // skip commented lines
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    if (/(^|[^\\])%/.test(src.slice(lineStart, m.index + m[1].length))) continue;
    const name = m[3].trim();
    const cands = /\.(tex|pltx)$/i.test(name) ? [name] : [`${name}.tex`, `${name}.pltx`, name];
    let body = null;
    let used = null;
    for (const c of cands) {
      body = await read(join(dir, c)).catch(() => null);
      if (body != null) { used = c; break; }
    }
    if (body == null) continue;
    if (m[2] === 'subfile') {
      const b = /\\begin\s*\{document\}([\s\S]*)\\end\s*\{document\}/.exec(body);
      if (b) body = b[1];
    }
    const sub = join(dir, used).replace(/[\\/][^\\/]*$/, '');
    const inner = await flatten(body, sub, read, join, depth + 1);
    out += src.slice(at, m.index + m[1].length) + (m[2] === 'include' ? '\\clearpage\n' : '') + inner + '\n';
    at = m.index + m[0].length;
  }
  return out + src.slice(at);
}

/* ---------------- the document ---------------- */
function splitDoc(text) {
  const s = String(text);
  const b = /\\begin\s*\{document\}/.exec(s);
  const e = /\\end\s*\{document\}/.exec(s);
  if (!b) return { pre: '', body: s, post: '' };
  const bodyStart = b.index + b[0].length;
  const bodyEnd = e && e.index > bodyStart ? e.index : s.length;
  return { pre: s.slice(0, b.index), begin: b[0], body: s.slice(bodyStart, bodyEnd), post: s.slice(bodyEnd) };
}

/**
 * The diff document of two versions (already flattened if wanted).
 * Returns { text, stats: { add, del } }.
 */
export function latexDiff(oldText, newText, { style = 'UNDERLINE', cells = true, labels = {} } = {}) {
  const st = DIFF_STYLES.includes(style) ? style : 'UNDERLINE';
  const A = splitDoc(oldText);
  const B = splitDoc(newText);
  const stats = { add: 0, del: 0 };
  const body = diffBlocks(tokenize(A.body), tokenize(B.body), stats);
  const appendix = cells ? pythonCellsAppendix(oldText, newText, labels) : '';
  if (!B.begin) return { text: body, stats };
  const text = `${B.pre}${preambleOf(st)}\n${B.begin}${body}${appendix}${B.post}`;
  return { text, stats };
}
