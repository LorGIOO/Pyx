import { render } from 'solid-js/web';
import { onMount } from 'solid-js';
import App from './solid/App.jsx';
import PreviewPane from './solid/components/PreviewPane.jsx';
import { state } from './core/state.js';
import {
  detectEnv, isTauri, openExternal, onAppEvent, focusSelf, invoke,
} from './core/platform.js';
import { setChangeHandler } from './editor/setup.js';
import {
  openDocument, saveActive, closeActive, splitActivePane, openFromOs,
} from './solid/stores/docStore.js';
import { compileActive, scheduleLiveCompile, reloadLastPdf } from './compile/compiler.js';
import { loadPdf } from './pdf/preview.js';
import { openFind, runAll, gotoLineCol, forwardSearch, buildLineToSource } from './editor/commands.js';
import { openPath } from './solid/stores/docStore.js';
import { openNewDoc } from './solid/components/NewDocDialog.jsx';
import { closeDialogs } from './solid/stores/dialogStore.js';
import { lastArea, setPdfSearchOpen, setAuxOpen } from './solid/stores/previewStore.js';
import { ensureKernel, restartKernel } from './editor/cell-runner.js';
import {
  initSettings, general, gv, setGeneral, setSession, getSession,
} from './solid/stores/settingsStore.js';
import {
  registerKeyHandlers, comboFromEvent, comboOf, findAction, runAction,
} from './solid/stores/keysStore.js';

// QA builds only (`VITE_PYX_QA=1 vite build`): the end-to-end suite reads the
// app's state instead of scraping it from the screen. A normal build replaces
// the condition with `undefined` and drops this line entirely.
if (import.meta.env.VITE_PYX_QA) {
  window.__pyxQA = { state, compileActive, saveActive, openPath, runAction };
}

// No web-style right-click menu anywhere (removes "Inspeccionar elemento", etc.).
window.addEventListener('contextmenu', (e) => e.preventDefault());

// Links produced by Python (or anywhere in the UI) open in the system browser,
// never inside the app.
window.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (/^https?:\/\//i.test(href)) {
    e.preventDefault();
    openExternal(href);
  }
}, true);

// Apply any saved syntax-highlight customizations.
initSettings();

// The auxiliary viewer window is created with an init script that defines
// __PYX_VIEWER__ (a query string would be percent-encoded by WebviewUrl::App).
const viewerBoot = typeof window.__PYX_VIEWER__ === 'object' ? window.__PYX_VIEWER__ : null;

if (viewerBoot) {
  // ---- auxiliary PDF-viewer window (the app's own viewer, detached) ----
  const pdfPath = viewerBoot.pdf ? decodeURIComponent(viewerBoot.pdf) : null;
  const ViewerWindow = () => {
    onMount(() => {
      if (pdfPath) loadPdf(pdfPath).catch(() => {});
      // The main window reuses this window for later PDFs (no close/reopen):
      // it emits viewer:load with the new percent-encoded path.
      onAppEvent('viewer:load', (p) => {
        if (p) loadPdf(decodeURIComponent(String(p))).catch(() => {});
      });
    });
    // The detached viewer has its own search (Ctrl+F opens the PDF search bar).
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setPdfSearchOpen(true);
      }
    });
    // Follow the main window's theme when it changes while this window is open.
    onAppEvent('theme:set', (id) => {
      if (id) document.documentElement.dataset.theme = String(id);
    });
    return (
      <div class="preview-pane" style={{ height: '100vh' }}>
        <PreviewPane />
      </div>
    );
  };
  render(() => <ViewerWindow />, document.getElementById('app-root'));
} else {
  // ---- main application ----
  // Live compile (TeXstudio-style): every edit re-arms a short timer; when
  // typing pauses, the document compiles in the background without blocking.
  setChangeHandler(() => scheduleLiveCompile());
  if (general.liveCompile === false) state.liveCompile = false;
  // When the detached viewer window closes, bring the in-app pane back with
  // the latest PDF (compiles were updating the auxiliary window meanwhile).
  onAppEvent('viewer:closed', () => {
    setAuxOpen(false);
    state.previewVisible = true;
    // Defer to after the pane has remounted (its onMount sets the container);
    // then load fresh so the latest compiled PDF shows.
    requestAnimationFrame(() => reloadLastPdf());
  });

  // Ctrl+click in the detached viewer → open that source file here, at the
  // exact line (SyncTeX), and bring the main window forward. The viewer has no
  // compile state, so build-file lines are translated HERE (the build copies
  // are clean LaTeX with the cells removed — lines shift below every cell).
  onAppEvent('synctex:open', async (payload) => {
    if (!payload || !payload.path) return;
    await openPath(payload.path);
    const line = payload.buildLine
      ? buildLineToSource(payload.path, payload.line || 1)
      : payload.line || 1;
    requestAnimationFrame(() => gotoLineCol(line, payload.column, payload.word));
    focusSelf();
  });

  // Every app action is rebindable (Configuración → Atajos). Cell actions are
  // dispatched from inside the editor (dynamic-keys.js); these are global.
  registerKeyHandlers({
    'file.new': () => { openNewDoc(); },
    'file.open': () => { openDocument(); },
    'file.save': () => { saveActive(); },
    'file.close': () => { closeActive(); },
    'compile.run': () => { compileActive(); },
    'compile.live': () => {
      state.liveCompile = !state.liveCompile;
      setGeneral({ liveCompile: state.liveCompile });
    },
    'calc.runAll': () => { runAll(); },
    'calc.restart': () => { restartKernel(); },
    'view.forward': () => { forwardSearch(); },
    'view.zen': () => { state.zenMode = !state.zenMode; },
    'view.preview': () => { state.previewVisible = !state.previewVisible; },
    'view.terminal': () => { state.terminalVisible = !state.terminalVisible; },
    'view.split': () => { splitActivePane(); },
  });

  window.addEventListener('keydown', (e) => {
    // Escape closes what is on top: a dialog first (Configuración, Nuevo
    // documento, the assistants), then zen mode.
    if (e.key === 'Escape' && closeDialogs()) return;
    if (e.key === 'Escape' && state.zenMode) { state.zenMode = false; return; }
    const combo = comboFromEvent(e);
    if (!combo) return;
    // Focus-aware search stays special: PDF if the viewer was the last
    // interaction; otherwise the editor (CodeMirror handles it itself when
    // focused — then the event arrives here already defaultPrevented).
    if (combo === comboOf('edit.find')) {
      if (lastArea() === 'pdf' && state.previewVisible) {
        e.preventDefault();
        setPdfSearchOpen(true);
      } else if (!e.defaultPrevented) {
        e.preventDefault();
        openFind();
      }
      return;
    }
    const id = findAction(combo);
    if (id && id !== 'edit.find' && runAction(id)) e.preventDefault();
  });

  // Ctrl+wheel / touchpad pinch must zoom the PDF (or do nothing), never the
  // whole interface (WebView2's page zoom would scale every panel).
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    // Over the editor it zooms the TEXT (Configuración → Editor → «Zoom con
    // Ctrl + rueda»). This has to live here rather than in a CodeMirror
    // handler: the listener above runs in the capture phase, and CodeMirror
    // drops any event that already had preventDefault() called on it.
    if (gv('wheelZoom') === false) return;
    const el = e.target;
    if (!el || !el.closest || !el.closest('.editor-host')) return;
    const cur = +gv('fontSize') || 13.5;
    const next = Math.min(40, Math.max(6, +(cur + (e.deltaY < 0 ? 0.5 : -0.5)).toFixed(1)));
    if (next !== cur) setGeneral({ fontSize: next });
  }, { passive: false, capture: true });

  // Documents the OS hands us: a double-clicked .pltx (the bundle registers
  // the file type), "Open with…", or a second launch while the app is already
  // running. Nothing listened for these before, so the file association opened
  // Pyx on an empty untitled document instead of the file that was clicked.
  onAppEvent('app:open-files', (paths) => {
    if (Array.isArray(paths) && paths.length) openFromOs(paths);
  });

  /* ---- autoguardado + sesión (Configuración → General) ----
     One slow timer does both jobs. It remembers which files are open (so
     "restaurar la sesión" can reopen them next launch) and, when autosave is
     on, saves the active document once its interval has elapsed — only if it
     already has a path, so a save dialog can never pop up on its own. */
  let lastAutosave = Date.now();
  setInterval(() => {
    try {
      setSession(state.documents.filter((d) => !d.kind && d.path).map((d) => d.path));
    } catch (_) { /* storage full / unavailable */ }
    if (gv('autosave') !== true) { lastAutosave = Date.now(); return; }
    const every = Math.max(1, Math.min(60, Math.round(+gv('autosaveMin') || 5))) * 60_000;
    if (Date.now() - lastAutosave < every) return;
    lastAutosave = Date.now();
    const doc = state.documents[state.activeIndex];
    if (doc && !doc.kind && doc.path && doc.modified) saveActive();
  }, 5000);

  /** Reopen the files of the last session, in order. */
  async function restoreSession() {
    for (const p of getSession()) {
      try { await openPath(p); } catch (_) { /* moved or deleted — skip it */ }
    }
  }

  render(() => <App />, document.getElementById('app-root'));

  // Probe the toolchain (Python + LaTeX) and warm up the kernel in the background.
  if (isTauri()) {
    detectEnv()
      .then((env) => { state.env = env; })
      .catch(() => {});
    ensureKernel().catch(() => {});
    // Anything the OS delivered before the listener above existed (a cold
    // start always beats the webview).
    //
    // Nothing is opened when the OS delivered nothing: the app starts on its
    // start page. A blank "sin-título" used to appear instead, which meant
    // every launch began by offering an unsaved document nobody had asked
    // for — and closing it was the first thing to do before opening the real
    // project.
    invoke('take_pending_open')
      .then((paths) => {
        if (Array.isArray(paths) && paths.length) return openFromOs(paths);
        // Nothing was double-clicked: honor "restaurar la sesión al abrir".
        return gv('restoreSession') === true ? restoreSession() : null;
      })
      .catch(() => {});
  }
}
