// CodeMirror 6 setup + the multi-pane editor host (VSCode-style splits).
//
// Each pane owns one EditorView. Per-document EditorStates live in `docStates`
// when no pane shows them. When two panes show the SAME document, each pane
// has its own forked state (independent cursor/scroll, like VSCode) and edits
// are forwarded between the views as annotated transactions so the text never
// diverges.

import { EditorState, Annotation, Compartment } from '@codemirror/state';
import { showMinimap } from '@replit/codemirror-minimap';
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightWhitespace,
  highlightTrailingWhitespace,
  drawSelection,
  dropCursor,
  keymap,
} from '@codemirror/view';
import {
  StreamLanguage,
  indentOnInput,
  indentUnit,
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
} from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import {
  defaultKeymap, history, historyKeymap, indentWithTab, insertNewline,
} from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, autocompletion } from '@codemirror/autocomplete';

import { state as appState } from '../core/state.js';
import { docIdFacet } from './doc-id.js';
import { cellsExtension, selectCellOrAll, refreshCells } from './cells.js';
import {
  toggleLineComment, smartEnter, moveCellOrLineUp, moveCellOrLineDown,
} from './commands.js';
import { bookmarks, toggleBookmarkAtCursor, nextBookmark, prevBookmark } from './bookmarks.js';
import { calcCompletions } from './autocomplete.js';
import { pyGhost } from './py-ghost.js';
import { pyLint } from './py-lint.js';
import { latexHighlight } from './latex-highlight.js';
import { indentGuides } from './indent-guides.js';
import { pyxSearchPanel } from './search-panel.js';
import { dynamicKeys } from './dynamic-keys.js';
import { pathLinks } from './link-paths.js';
import { latexFold } from './latex-fold.js';
import { spellCheck, spellRefresh } from './spellcheck.js';
import { setDocSnap, scheduleDerived } from '../solid/stores/structureStore.js';
import { gv } from '../solid/stores/settingsStore.js';

// Marks transactions that were forwarded from a sibling pane (prevents loops).
const syncAnnotation = Annotation.define();

/* ---------- minimap (VSCode-style), toggleable from Configuración ---------- */
const minimapCompartment = new Compartment();
const mkMinimap = () => showMinimap.compute([], () => ({
  create: () => ({ dom: document.createElement('div') }),
  displayText: 'blocks',
  showOverlay: 'always',
}));
const minimapExt = () => minimapCompartment.of(gv('minimap') === true ? mkMinimap() : []);

/** Turn the minimap on/off LIVE in every pane and every stored doc state. */
export function setMinimapEnabled(on) {
  const eff = minimapCompartment.reconfigure(on ? mkMinimap() : []);
  for (const vw of paneViews.values()) {
    try { vw.dispatch({ effects: eff }); } catch (_) {}
  }
  for (const [id, st] of docStates) {
    try { docStates.set(id, st.update({ effects: eff }).state); } catch (_) {}
  }
}

/* ---------- editor options (Configuración → Editor / Autocompletado) ----------
 *
 * Everything the user can switch on or off that is BEHAVIOUR rather than
 * appearance lives in one compartment, so changing a checkbox reconfigures
 * every open pane AND every stored document state at once — no reload, no lost
 * cursor, no lost undo history. Appearance (font, spacing, rulers, cursor
 * width) goes through CSS instead: see settingsStore.applyGeneral.
 */
const optsCompartment = new Compartment();

/* Completion source honoring "distinguir mayúsculas y minúsculas".
 *
 * CodeMirror filters candidates case-insensitively and has no switch for it, so
 * the strict mode is applied HERE: the options that do not share the typed
 * prefix exactly are dropped, and `validFor` is removed so every extra
 * keystroke re-queries instead of reusing the loose client-side filter.
 * The leading backslash of a LaTeX command is ignored on both sides. */
async function completionSource(context) {
  const res = await calcCompletions(context);
  if (!res || !res.options || gv('completionCaseSensitive') !== true) return res;
  const typed = context.state.sliceDoc(res.from, context.pos).replace(/^\\/, '');
  if (!typed) return res;
  const options = res.options.filter(
    (o) => String(o.label || '').replace(/^\\/, '').startsWith(typed),
  );
  return { ...res, options, validFor: undefined };
}

const clampInt = (v, def, lo, hi) => {
  const n = Math.round(+v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

/** The live extension set for every option in Configuración → Editor. */
function editorOptions() {
  const tabSize = clampInt(gv('tabSize'), 4, 1, 16);
  const ext = [
    EditorState.tabSize.of(tabSize),
    // What Tab and auto-indent actually insert.
    indentUnit.of(gv('indentWithSpaces') === false ? '\t' : ' '.repeat(tabSize)),
  ];
  if (gv('autoIndent') !== false) ext.push(indentOnInput());
  if (gv('lineWrap') !== false) ext.push(EditorView.lineWrapping);
  if (gv('indentGuidesOn') !== false) ext.push(indentGuides);
  if (gv('activeLine') !== false) ext.push(highlightActiveLine(), highlightActiveLineGutter());
  if (gv('matchBrackets') !== false) ext.push(bracketMatching());
  if (gv('closeBrackets') !== false) ext.push(closeBrackets());
  if (gv('selectionMatches') !== false) ext.push(highlightSelectionMatches());
  if (gv('showWhitespace') === true) ext.push(highlightWhitespace());
  if (gv('showTrailingWs') === true) ext.push(highlightTrailingWhitespace());
  // Live "ghost" values shown after each \py{…} (Mathcad/MATLAB-style). It
  // lives here so switching it off in Configuración drops the decorations at
  // once: the plugin recomputes only on edits, never on a plain settings read.
  if (gv('pyGhost') !== false) ext.push(pyGhost);
  // "Zoom con Ctrl + rueda" is NOT an editor extension: main.jsx swallows every
  // Ctrl+wheel in the capture phase (WebView2 would otherwise zoom the whole
  // interface), and CodeMirror ignores any event already defaultPrevented. The
  // zoom therefore lives next to that listener.
  // TeXstudio's "Cursor Surrounding Lines": never let the caret touch the edge.
  const margin = clampInt(gv('cursorMargin'), 0, 0, 30);
  if (margin > 0) {
    ext.push(EditorView.scrollMargins.of((view) => {
      const h = view.defaultLineHeight * margin;
      return { top: h, bottom: h };
    }));
  }
  if (gv('completion') !== false) {
    ext.push(autocompletion({
      override: [completionSource],
      activateOnTyping: gv('completionOnTyping') !== false,
      selectOnOpen: gv('completionSelectFirst') !== false,
      icons: gv('completionIcons') !== false,
    }));
  }
  return ext;
}

/** Re-apply Configuración → Editor to every pane and every stored document. */
export function applyEditorSettings() {
  const eff = optsCompartment.reconfigure(editorOptions());
  for (const vw of paneViews.values()) {
    try { vw.dispatch({ effects: eff }); } catch (_) {}
  }
  for (const [id, st] of docStates) {
    try { docStates.set(id, st.update({ effects: eff }).state); } catch (_) {}
  }
}

// Debounced mirror of the active document → drives the side panel, breadcrumbs
// and word count.
//
// We publish CodeMirror's immutable `Text` (a rope), never a string: the old
// code called `doc.toString()` on every keystroke, so a 30 MB project allocated
// and threw away 30 MB per character typed. Holding the rope is O(1); the
// consumers stream it line by line.
let docTextTimer = null;
function pushDocText(doc) {
  clearTimeout(docTextTimer);
  docTextTimer = setTimeout(() => publishDoc(doc), 200);
}

function publishDoc(doc) {
  setDocSnap(doc);
  scheduleDerived(doc);
}


// Called on every document edit (wired by main.jsx to the live compiler —
// injected to avoid a static import cycle: compiler imports this module).
let changeHandler = null;
export function setChangeHandler(fn) {
  changeHandler = fn;
}

/* ---------- panes ---------- */
const paneViews = new Map(); // paneId -> EditorView
const paneDocs = new Map();  // paneId -> docId whose state the view holds
const docStates = new Map(); // docId -> EditorState (canonical when unmounted)

function viewsOfDoc(docId, exceptPane = null) {
  const out = [];
  for (const [pid, vw] of paneViews) {
    if (pid !== exceptPane && paneDocs.get(pid) === docId) out.push(vw);
  }
  return out;
}

// Mark the matching document modified, keep the status-bar cursor fresh, and
// forward edits to sibling panes showing the same document.
function makeUpdateListener(docId) {
  return EditorView.updateListener.of((u) => {
    if (u.docChanged) {
      const doc = appState.documents.find((d) => d.id === docId);
      if (doc && !doc.modified) doc.modified = true;
      pushDocText(u.state.doc);

      const fromSync = u.transactions.some((tr) => tr.annotation(syncAnnotation));
      if (!fromSync && changeHandler) changeHandler();
      if (!fromSync) {
        // Which pane produced this update?
        let srcPane = null;
        for (const [pid, vw] of paneViews) if (vw === u.view) { srcPane = pid; break; }
        for (const vw of viewsOfDoc(docId, srcPane)) {
          for (const tr of u.transactions) {
            if (!tr.docChanged) continue;
            vw.dispatch({ changes: tr.changes, annotations: syncAnnotation.of(true) });
          }
        }
      }
    }
    if (u.selectionSet || u.docChanged) {
      const head = u.state.selection.main.head;
      const line = u.state.doc.lineAt(head);
      appState.cursor = { line: line.number, col: head - line.from + 1 };
    }
  });
}

export function createDocState(docId, content) {
  return EditorState.create({
    doc: content ?? '',
    extensions: [
      // Which document this state belongs to. Cell results are shared across
      // PANES but must never be shared across DOCUMENTS, so the output store
      // namespaces by this.
      docIdFacet.of(docId),
      // Bookmark gutter sits LEFT of the line numbers (TeXstudio layout).
      bookmarks,
      lineNumbers(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      search({ top: true, createPanel: pyxSearchPanel }),
      StreamLanguage.define(stex),
      // Everything the user can switch in Configuración → Editor /
      // Autocompletado: tabulación, indentación, ajuste de línea, guías,
      // línea activa, paréntesis, espacios en blanco, zoom con la rueda…
      optsCompartment.of(editorOptions()),
      // VSCode-style minimap (Configuración → Editor → Minimapa).
      minimapExt(),
      latexHighlight,
      // TeXstudio-style folding: \begin/\end blocks and sections fold from the
      // gutter (hidden via Configuración → Editor → Plegado).
      codeFolding(),
      latexFold,
      foldGutter({ openText: '▾', closedText: '▸' }),
      // Word-style proofing: red spell underline + blue grammar underline.
      spellCheck,
      cellsExtension,
      // Live Python syntax squiggles in cells (VSCode-style, exact line/col).
      pyLint,
      // Cell shortcuts (run / run+advance / new cell) and save are DYNAMIC:
      // they read the user's bindings from Configuración → Atajos live.
      dynamicKeys,
      pathLinks,
      makeUpdateListener(docId),
      keymap.of([
        { key: 'Mod-a', run: selectCellOrAll },
        { key: 'Ctrl-t', run: toggleLineComment, preventDefault: true },
        { key: 'Enter', run: smartEnter },
        // "Indentación automática" off → Enter starts the new line at column 1.
        // Sits between smartEnter (\begin…\end, \item) and defaultKeymap's
        // insertNewlineAndIndent, and reads the setting live, so it needs no
        // reconfiguration of its own.
        { key: 'Enter', run: (view) => (gv('autoIndent') === false ? insertNewline(view) : false) },
        // Jupyter-style cell reorder (whole cell moves; plain lines otherwise).
        { key: 'Alt-ArrowUp', run: moveCellOrLineUp, preventDefault: true },
        { key: 'Alt-ArrowDown', run: moveCellOrLineDown, preventDefault: true },
        // TeXstudio-style bookmarks.
        { key: 'Ctrl-F2', run: toggleBookmarkAtCursor, preventDefault: true },
        { key: 'F2', run: nextBookmark, preventDefault: true },
        { key: 'Shift-F2', run: prevBookmark, preventDefault: true },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
    ],
  });
}

/* ---------- pane lifecycle ---------- */
export function mountPane(paneId, parent) {
  const view = new EditorView({ parent });
  paneViews.set(paneId, view);
  if (typeof window !== 'undefined') window.__calcView = view; // debug handle
  return view;
}

export function unmountPane(paneId) {
  persistPaneDoc(paneId);
  const view = paneViews.get(paneId);
  if (view) view.destroy();
  paneViews.delete(paneId);
  paneDocs.delete(paneId);
}

// Save the pane's editor state back to docStates when it's the last view of
// that document (otherwise a sibling pane keeps the live copy).
function persistPaneDoc(paneId) {
  const docId = paneDocs.get(paneId);
  const view = paneViews.get(paneId);
  if (docId == null || !view) return;
  if (viewsOfDoc(docId, paneId).length === 0 && docStates.has(docId)) {
    docStates.set(docId, view.state);
  }
}

/** Show a (text) document in a pane. Forks the state if a sibling pane already
 * shows it, so each pane gets an independent cursor over the same text. */
export function showDocInPane(paneId, docId) {
  const view = paneViews.get(paneId);
  if (!view) return;
  if (paneDocs.get(paneId) === docId) return;
  persistPaneDoc(paneId);
  paneDocs.set(paneId, docId);

  const siblings = viewsOfDoc(docId, paneId);
  let st;
  if (siblings.length) {
    st = createDocState(docId, siblings[0].state.doc);
  } else {
    st = docStates.get(docId) || createDocState(docId, '');
  }
  view.setState(st);
  publishDoc(view.state.doc);
  if (paneId === appState.activePaneId) requestAnimationFrame(() => view.focus());
}

export function getView() {
  return paneViews.get(appState.activePaneId) || paneViews.values().next().value || null;
}

/** The editor view that currently holds a given document, if any pane shows it.
 * The compiler must use THIS (not the focused pane, which may show another
 * document or a viewer tab). */
export function getViewOfDoc(docId) {
  for (const [pid, did] of paneDocs) {
    if (did === docId) return paneViews.get(pid) || null;
  }
  return null;
}

export function getPaneView(paneId) {
  return paneViews.get(paneId) || null;
}

/** Dispatch a cells-refresh to every pane so shared outputs repaint everywhere. */
export function broadcastCellRefresh() {
  for (const vw of paneViews.values()) {
    try { vw.dispatch({ effects: refreshCells.of(null) }); } catch (_) {}
  }
}

/** Re-run spell/grammar checking in every pane (after a setting change). */
export function broadcastSpellRefresh() {
  for (const vw of paneViews.values()) {
    try { vw.dispatch({ effects: spellRefresh.of(null) }); } catch (_) {}
  }
}

/* ---------- documents ---------- */
export function registerDoc(id, content) {
  docStates.set(id, createDocState(id, content));
}

export function getDocContent(id) {
  for (const [pid, vw] of paneViews) {
    if (paneDocs.get(pid) === id) return vw.state.doc.toString();
  }
  const st = docStates.get(id);
  return st ? st.doc.toString() : '';
}

export function disposeDoc(id) {
  docStates.delete(id);
  for (const [pid, did] of [...paneDocs]) {
    if (did === id) paneDocs.delete(pid);
  }
}
