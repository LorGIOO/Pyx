import { render } from 'solid-js/web';
import { onMount } from 'solid-js';
import App from './solid/App.jsx';
import PreviewPane from './solid/components/PreviewPane.jsx';
import { state } from './core/state.js';
import { detectEnv, isTauri, openExternal, onAppEvent, focusSelf } from './core/platform.js';
import { setChangeHandler } from './editor/setup.js';
import {
  newDocument, openDocument, saveActive, closeActive, splitActivePane,
} from './solid/stores/docStore.js';
import { compileActive, scheduleLiveCompile, reloadLastPdf } from './compile/compiler.js';
import { loadPdf } from './pdf/preview.js';
import { openFind, runAll, gotoLineCol } from './editor/commands.js';
import { openPath } from './solid/stores/docStore.js';
import { lastArea, setPdfSearchOpen, setAuxOpen } from './solid/stores/previewStore.js';
import { ensureKernel, restartKernel } from './editor/cell-runner.js';
import { initSettings, general, setGeneral } from './solid/stores/settingsStore.js';
import {
  registerKeyHandlers, comboFromEvent, comboOf, findAction, runAction,
} from './solid/stores/keysStore.js';

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
  // exact line (SyncTeX), and bring the main window forward.
  onAppEvent('synctex:open', async (payload) => {
    if (!payload || !payload.path) return;
    await openPath(payload.path);
    requestAnimationFrame(() => gotoLineCol(payload.line || 1, payload.column, payload.word));
    focusSelf();
  });

  // Every app action is rebindable (Configuración → Atajos). Cell actions are
  // dispatched from inside the editor (dynamic-keys.js); these are global.
  registerKeyHandlers({
    'file.new': () => { newDocument(); },
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
    'view.zen': () => { state.zenMode = !state.zenMode; },
    'view.preview': () => { state.previewVisible = !state.previewVisible; },
    'view.terminal': () => { state.terminalVisible = !state.terminalVisible; },
    'view.split': () => { splitActivePane(); },
  });

  window.addEventListener('keydown', (e) => {
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
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false, capture: true });

  render(() => <App />, document.getElementById('app-root'));

  // Open a starter document so the app is useful on first launch.
  newDocument();

  // Probe the toolchain (Python + LaTeX) and warm up the kernel in the background.
  if (isTauri()) {
    detectEnv()
      .then((env) => { state.env = env; })
      .catch(() => {});
    ensureKernel().catch(() => {});
  }
}
