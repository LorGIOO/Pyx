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
  drawSelection,
  dropCursor,
  keymap,
} from '@codemirror/view';
import {
  StreamLanguage,
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
} from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, autocompletion } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

import { state as appState } from '../core/state.js';
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
import { setDocText } from '../solid/stores/structureStore.js';
import { general } from '../solid/stores/settingsStore.js';

// Marks transactions that were forwarded from a sibling pane (prevents loops).
const syncAnnotation = Annotation.define();

/* ---------- minimap (VSCode-style), toggleable from Configuración ---------- */
const minimapCompartment = new Compartment();
const mkMinimap = () => showMinimap.compute([], () => ({
  create: () => ({ dom: document.createElement('div') }),
  displayText: 'blocks',
  showOverlay: 'always',
}));
const minimapExt = () => minimapCompartment.of(general.minimap === true ? mkMinimap() : []);

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

// Debounced mirror of the active document text → drives the side panel.
let docTextTimer = null;
function pushDocText(text) {
  clearTimeout(docTextTimer);
  docTextTimer = setTimeout(() => setDocText(text), 200);
}

// Syntax colors are CSS classes so they follow the theme variables.
const calcHighlight = HighlightStyle.define([
  { tag: t.comment, class: 'tok-comment' },
  { tag: t.lineComment, class: 'tok-comment' },
  { tag: [t.string, t.special(t.string)], class: 'tok-string' },
  { tag: [t.number, t.integer, t.float], class: 'tok-number' },
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], class: 'tok-keyword' },
  { tag: [t.tagName, t.atom, t.labelName, t.macroName], class: 'tok-tag' },
  { tag: [t.bracket, t.squareBracket, t.brace, t.paren, t.punctuation], class: 'tok-bracket' },
]);

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
      pushDocText(u.state.doc.toString());

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
      // Bookmark gutter sits LEFT of the line numbers (TeXstudio layout).
      bookmarks,
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ override: [calcCompletions], activateOnTyping: true }),
      highlightSelectionMatches(),
      search({ top: true, createPanel: pyxSearchPanel }),
      StreamLanguage.define(stex),
      syntaxHighlighting(calcHighlight),
      // Vertical indent guides (TeXstudio-style hierarchy lines).
      indentGuides,
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
      EditorView.lineWrapping,
      cellsExtension,
      // Live "ghost" values shown after each \py{…} (Mathcad/MATLAB-style).
      pyGhost,
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
  setDocText(view.state.doc.toString());
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
