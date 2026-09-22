// Central reactive state, shared between the SolidJS UI and the editor layer.
// Uses createMutable so any component reading a field re-renders on change.
import { createMutable } from 'solid-js/store';

export const state = createMutable({
  // Open documents. Each: { id, fileName, path, modified, engine, kind?, payload? }
  // kind: undefined|'tex' = editable LaTeX; 'image'|'html' = viewer tabs
  // (cell outputs opened as documents, VSCode-style).
  documents: [],
  activeIndex: -1,

  // Editor split panes (VSCode-style). Each pane shows one open document and
  // hosts its own editor view; several panes may show the same document.
  panes: [{ id: 1, docId: null }],
  activePaneId: 1,

  // UI
  theme: document.documentElement.dataset.theme || 'light',
  previewVisible: true,
  logVisible: false,
  terminalVisible: false, // in-app terminal (pip install, etc.)
  sidePanelTab: null, // null | 'structure' | 'toc' | 'symbols' | 'files'
  sidePanelHidden: false, // hide the whole side panel (strip included)
  viewerMaximized: false, // show only the PDF viewer (hide the editor)
  zenMode: false, // zen: only tabs + editor + viewer (Esc exits)
  hideOutputs: false, // collapse cell outputs (calcs still run + compile)
  cellsCollapsed: false, // all cells folded to a thin cap (code + output)
  editorRatio: 0.5, // editor pane fraction of the content width

  // Toolchain / runtime
  env: { python: null, latex: null, engines: [] },
  kernelStatus: 'idle', // idle | starting | ready | busy | error
  // True when a soft interrupt has not taken hold: the stop button then offers
  // the forced kill instead of repeating a word that plainly did nothing.
  kernelForceHint: false,
  // True when the PDF on screen was built from a DIFFERENT document than the
  // one being edited. The viewer says so rather than going blank: an old PDF
  // is still worth looking at, as long as you know whose it is.
  pdfForeign: false,
  compiling: false,
  compileQueued: false, // a compile was asked for mid-compile and runs right after
  liveCompile: true, // TeXstudio-style: background compile shortly after typing stops
  lastLog: '',
  lastCompileOk: null, // null | true | false
  compileMs: 0,        // how long the last compile took (drives the live backoff)
  liveSuspended: false, // project too heavy to rebuild on every typing pause
  lastPdfPath: null,    // PDF written by the last successful compile
  // The build↔source line maps do NOT live here: they are large arrays of
  // integers that nothing renders, and a reactive store would wrap every one
  // of those integers in a proxy trap. See compile/build-maps.js.

  // Editor cursor info for the status bar
  cursor: { line: 1, col: 1 },
});

export function activeDoc() {
  return state.documents[state.activeIndex] || null;
}
