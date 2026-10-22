// \begin{…} / \end{…} in the editor: one place that knows where an
// environment's name is, which \end closes a \begin (and the reverse), and
// whether an environment is already closed — so Enter, the autocompletion and
// the begin↔end renaming never add a second \end or break a name in two.
//
// Everything here works with ONE cursor. The generic "\begin{ }" completion
// used to be a snippet with a linked field: two cursors, one in each name.
// Those two cursors outlived the name — Enter split BOTH lines and everything
// typed afterwards appeared twice. Now the \end follows the \begin through the
// rename filter (latex-extras.js) and Enter/Tab step into the body.

import { EditorState, Annotation } from '@codemirror/state';
import { getIndentUnit, indentString } from '@codemirror/language';

const ENV_TOKEN = /\\(begin|end)\s*\{([^}\n]*)\}/g;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text with every LaTeX comment blanked out (same length, so positions
 *  stay valid): a commented-out \end{x} must not count as closing x. */
export function blankComments(text) {
  return text.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, (m, pre, bs) => pre + bs + ' '.repeat(m.length - pre.length - bs.length));
}

/** The \begin{name} or \end{name} whose NAME span holds column `col` of
 *  `line` (the braces' inside, both ends included): { kind, name, from, to }. */
export function envNameAt(line, col) {
  ENV_TOKEN.lastIndex = 0;
  let m;
  while ((m = ENV_TOKEN.exec(line))) {
    const from = m.index + m[0].indexOf('{') + 1;
    const to = from + m[2].length;
    if (col >= from && col <= to) return { kind: m[1], name: m[2], from, to };
    if (m.index > col) break;
  }
  return null;
}

function tokensOf(text, name) {
  return new RegExp(`\\\\(begin|end)\\s*\\{${escapeRe(name)}\\}`, 'g');
}

/** Name span of the \end that closes a \begin{name} ending at `after`,
 *  counting nested environments of the same name. */
export function matchingEnd(text, after, name) {
  const re = tokensOf(text, name);
  re.lastIndex = after;
  let depth = 1, m;
  while ((m = re.exec(text))) {
    depth += m[1] === 'begin' ? 1 : -1;
    if (depth === 0) {
      const from = m.index + m[0].indexOf('{') + 1;
      return { from, to: from + name.length };
    }
  }
  return null;
}

/** Name span of the \begin that an \end{name} starting at `before` closes. */
export function matchingBegin(text, before, name) {
  const re = tokensOf(text, name);
  const found = [];
  let m;
  while ((m = re.exec(text)) && m.index < before) found.push(m);
  let depth = 1;
  for (let i = found.length - 1; i >= 0; i--) {
    depth += found[i][1] === 'end' ? 1 : -1;
    if (depth === 0) {
      const from = found[i].index + found[i][0].indexOf('{') + 1;
      return { from, to: from + name.length };
    }
  }
  return null;
}

/** Is the \begin{name} whose `}` is at `after - 1` already closed?
 *  It needs an \end that matches it AND no more \begin{name} than \end{name}
 *  in the whole document: a new \begin{itemize} typed inside another itemize
 *  would otherwise "find" the outer one's \end and stay unclosed. */
export function envIsClosed(text, after, name) {
  const t = blankComments(text);
  if (!matchingEnd(t, after, name)) return false;
  let begins = 0, ends = 0, m;
  const re = tokensOf(t, name);
  while ((m = re.exec(t))) { if (m[1] === 'begin') begins++; else ends++; }
  return begins <= ends;
}

/* ---------- renaming one name renames the other ---------- */

const envSync = Annotation.define();

/**
 * Typing in a \begin name renames its \end, typing in an \end name renames its
 * \begin — inside the user's OWN transaction, not a follow-up one: the history
 * only joins adjacent edits, so a separate change made Ctrl+Z undo the two
 * names one at a time, leaving \begin{enumerate} … \end{enumerat}.
 * One edit and one cursor only: a paste, a replace-all or a multi-cursor edit
 * is not a rename. `enabled()` reads the user's setting live.
 */
export function envRenameFilter(enabled = () => true) {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(envSync) || !enabled()) return tr;
    if (!tr.isUserEvent('input') && !tr.isUserEvent('delete')) return tr;
    if (tr.startState.selection.ranges.length > 1) return tr;
    let edit = null;
    tr.changes.iterChanges((fromA, toA, fromB, toB) => { edit = edit === null ? { fromA, toA, fromB, toB } : false; });
    if (!edit) return tr;
    const oldLine = tr.startState.doc.lineAt(edit.fromA);
    const old = envNameAt(oldLine.text, edit.fromA - oldLine.from);
    // An empty name is followed too: select "itemize", delete it, type
    // "enumerate" — the other name has to go through {} on the way.
    if (!old || edit.toA - oldLine.from > old.to) return tr;
    const newLine = tr.newDoc.lineAt(edit.fromB);
    const now = envNameAt(newLine.text, edit.fromB - newLine.from);
    if (!now || now.kind !== old.kind || now.name === old.name || !/^[A-Za-z*@]*$/.test(now.name)) return tr;
    const text = tr.startState.doc.toString();
    const other = old.kind === 'begin'
      ? matchingEnd(text, oldLine.from + old.to + 1, old.name)
      : matchingBegin(text, oldLine.from + oldLine.text.lastIndexOf('\\end', old.from), old.name);
    if (!other) return tr;
    const from = tr.changes.mapPos(other.from), to = tr.changes.mapPos(other.to);
    if (tr.newDoc.sliceString(from, to) !== old.name) return tr;
    return [tr, { changes: { from, to, insert: now.name }, sequential: true, annotations: envSync.of(true) }];
  });
}

/** One indentation step as the editor is configured (spaces or a tab). */
function unitOf(state) {
  try { return indentString(state, getIndentUnit(state)); } catch (_) { return '  '; }
}
const indentOf = (lineText) => (/^[ \t]*/.exec(lineText) || [''])[0];

/**
 * The skeleton of a new environment where the name is still to be typed:
 * `\begin{}`, an indented body line and `\end{}`, with ONE cursor between the
 * first braces. `from`/`to` is what it replaces (the typed `\beg…`).
 */
export function insertEnvSkeleton(view, from, to) {
  const { state } = view;
  const indent = indentOf(state.doc.lineAt(from).text);
  const head = '\\begin{';
  const insert = `${head}}\n${indent}${unitOf(state)}\n${indent}\\end{}`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + head.length },
    userEvent: 'input.complete',
    scrollIntoView: true,
  });
  return true;
}

/** Cursor on the body line right below the \begin line `beginLine`, creating
 *  that line when the \end is directly underneath. */
function stepIntoBody(view, beginLine, endFrom) {
  const { state } = view;
  const indent = indentOf(beginLine.text);
  const next = beginLine.number < state.doc.lines ? state.doc.line(beginLine.number + 1) : null;
  if (next && endFrom > next.to) {
    // There is a body already: go to the end of its first line.
    view.dispatch({ selection: { anchor: next.to }, scrollIntoView: true, userEvent: 'select' });
    return true;
  }
  const body = `\n${indent}${unitOf(state)}`;
  view.dispatch({
    changes: { from: beginLine.to, insert: body },
    selection: { anchor: beginLine.to + body.length },
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
}

/** Add the body and the \end{name} after the \begin line. */
function closeEnv(view, beginLine, name, cursorInName = null) {
  const { state } = view;
  const indent = indentOf(beginLine.text);
  const body = `\n${indent}${unitOf(state)}`;
  const close = `\n${indent}\\end{${name}}`;
  view.dispatch({
    changes: { from: beginLine.to, insert: body + close },
    selection: { anchor: cursorInName ?? beginLine.to + body.length },
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
}

/**
 * Enter (and Tab) on an environment's \begin line, single cursor only:
 *  - with the cursor INSIDE the name braces, never split the name: step into
 *    the body, adding the \end first if the environment has none (with no
 *    name yet, the cursor stays in the name, so the \end follows what you
 *    type);
 *  - at the END of a `\begin{x}` line, open the body and add `\end{x}` only
 *    when x is not closed yet (it used to add one every time).
 * Returns false when it does not apply, so the normal Enter/Tab runs.
 */
export function envEnter(view, { atLineEndOnly = false } = {}) {
  const { state } = view;
  if (state.selection.ranges.length !== 1) return false;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const col = sel.head - line.from;
  const text = state.doc.toString();

  // Cursor inside \begin{na|me}.
  const at = envNameAt(line.text, col);
  if (at && at.kind === 'begin' && !atLineEndOnly) {
    if (at.name === 'document') return false;
    const after = line.from + at.to + 1; // just past the `}`
    // No name yet and no \end: add an empty \end{} and keep the cursor in the
    // name — what is typed next goes to both.
    if (at.name === '' && !envIsClosed(text, after, '')) return closeEnv(view, line, '', line.from + at.from);
    if (envIsClosed(text, after, at.name)) {
      const end = matchingEnd(blankComments(text), after, at.name);
      return stepIntoBody(view, line, end ? end.from : Infinity);
    }
    return closeEnv(view, line, at.name);
  }

  // At the end of a line that ends with \begin{x} (optionally with its args).
  if (sel.head !== line.to) return false;
  const mb = /\\begin\s*\{([^}\n]+)\}(?:\s*(?:\[[^\]\n]*\]|\{[^}\n]*\}))*\s*$/.exec(line.text);
  if (!mb || mb[1] === 'document') return false;
  const name = mb[1];
  const after = line.from + mb.index + mb[0].indexOf('}') + 1;
  if (envIsClosed(text, after, name)) {
    // Already closed: just an indented body line, no second \end.
    const body = `\n${indentOf(line.text)}${unitOf(state)}`;
    view.dispatch({
      changes: { from: sel.head, insert: body },
      selection: { anchor: sel.head + body.length },
      scrollIntoView: true,
      userEvent: 'input',
    });
    return true;
  }
  return closeEnv(view, line, name);
}

/** Tab inside a \begin name: same as Enter there (into the body). */
export function envTab(view) {
  const { state } = view;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  const line = state.doc.lineAt(state.selection.main.head);
  const at = envNameAt(line.text, state.selection.main.head - line.from);
  if (!at || at.kind !== 'begin' || at.name === '' || at.name === 'document') return false;
  return envEnter(view);
}
