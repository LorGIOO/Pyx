// "Preparar Pyx": what a new user needs and does not have, set up with one
// click — Python with the scientific stack (uv, in Pyx's own folder) and
// LaTeX (Tectonic). Offered once when something is missing, from
// Configuración at any time, and for a single package when a cell fails with
// ModuleNotFoundError. The log of what is being done is shown live.

import { createSignal, For, Show, onCleanup } from 'solid-js';
import { state } from '../../core/state.js';
import { t } from '../../core/i18n.js';
import {
  detectEnv, installTectonic, setupPython, installPackages, onAppEvent, isTauri,
} from '../../core/platform.js';
import { setKernelPython, restartKernel } from '../../editor/cell-runner.js';
import { general, setGeneral } from '../stores/settingsStore.js';
import { registerDialog, closeDialogs } from '../stores/dialogStore.js';

const [open, setOpen] = createSignal(false);
const [want, setWant] = createSignal({ python: false, latex: false, packages: [] });
const [running, setRunning] = createSignal(false);
const [log, setLog] = createSignal([]);
const [error, setError] = createSignal('');
const [done, setDone] = createSignal(false);
registerDialog(open, () => { if (!running()) setOpen(false); });

/** Open the dialog for what is missing (or what is asked for). */
export function openSetup({ python = false, latex = false, packages = [] } = {}) {
  if (!isTauri()) return;
  closeDialogs();
  setWant({ python, latex, packages });
  setLog([]); setError(''); setDone(false);
  setOpen(true);
}

/** On start-up: offer what is missing, once (until "No volver a preguntar"). */
export function offerSetupIfMissing(env) {
  if (!env || general.setupNeverAsk) return;
  const python = !env.python;
  const latex = !(env.engines && env.engines.length);
  if (python || latex) openSetup({ python, latex });
}

// Import name → PyPI name, where they differ.
const PYPI = {
  sklearn: 'scikit-learn', cv2: 'opencv-python', PIL: 'pillow', yaml: 'pyyaml', bs4: 'beautifulsoup4',
  skimage: 'scikit-image', Crypto: 'pycryptodome', dateutil: 'python-dateutil', docx: 'python-docx',
  pptx: 'python-pptx', serial: 'pyserial', attr: 'attrs', jwt: 'PyJWT', dotenv: 'python-dotenv',
  fitz: 'pymupdf', OpenGL: 'PyOpenGL', usb: 'pyusb', mpl_toolkits: 'matplotlib', win32com: 'pywin32',
};
export const pypiName = (mod) => PYPI[mod] || mod;

/** Install one missing library into the kernel's interpreter. */
export function offerPackage(module) {
  openSetup({ packages: [pypiName(module)] });
}

async function start() {
  const w = want();
  setRunning(true); setError(''); setLog([]);
  const unlisten = await onAppEvent('setup:line', (line) => setLog((l) => [...l.slice(-300), line]));
  try {
    if (w.latex) {
      await installTectonic();
    }
    if (w.python) {
      const py = await setupPython([]);
      await setKernelPython(py);
    } else if (w.packages.length) {
      const py = state.env.python;
      if (!py) throw new Error(t('No hay ningún intérprete de Python en uso.', 'No Python interpreter in use.'));
      await installPackages(py, w.packages);
      // The running kernel would not see a package installed under it.
      await restartKernel();
    }
    try { state.env = { ...state.env, ...(await detectEnv()) }; } catch (_) { /* keep */ }
    setDone(true);
  } catch (e) {
    setError(String((e && e.message) || e));
  } finally {
    unlisten();
    setRunning(false);
  }
}

export default function SetupDialog() {
  let logEl;
  const scroll = () => { if (logEl) logEl.scrollTop = logEl.scrollHeight; };
  const timer = setInterval(scroll, 300);
  onCleanup(() => clearInterval(timer));
  const w = () => want();
  const title = () => (w().packages.length && !w().python && !w().latex
    ? t('Instalar paquete de Python', 'Install a Python package')
    : t('Preparar Pyx', 'Set up Pyx'));

  return (
    <Show when={open()}>
      <div class="cfg-overlay">
        <div class="cfg-modal setup-modal">
          <div class="cfg-titlebar">
            <span>{title()}</span>
            <button class="cfg-close" disabled={running()} title={t('Cerrar', 'Close')} onClick={() => setOpen(false)}>✕</button>
          </div>
          <div class="setup-body">
            <Show when={w().python || w().latex}>
              <p class="setup-lead">
                {t('Pyx puede preparar por sí mismo lo que falta en este equipo. Todo queda dentro de la carpeta de Pyx: no se toca el sistema ni otras instalaciones.',
                  'Pyx can set up what this computer is missing by itself. Everything stays inside Pyx\'s folder: the system and other installations are not touched.')}
              </p>
              <label class="setup-opt">
                <input type="checkbox" checked={w().python} disabled={running() || done()}
                  onChange={(e) => setWant({ ...w(), python: e.currentTarget.checked })} />
                <span>
                  <b>Python</b> {t('con numpy, scipy, sympy, pandas, matplotlib, handcalcs y pint', 'with numpy, scipy, sympy, pandas, matplotlib, handcalcs and pint')}
                  <small>{t('Lo instala uv (≈ 400 MB en disco, unos minutos la primera vez).', 'Installed by uv (≈ 400 MB on disk, a few minutes the first time).')}</small>
                </span>
              </label>
              <label class="setup-opt">
                <input type="checkbox" checked={w().latex} disabled={running() || done()}
                  onChange={(e) => setWant({ ...w(), latex: e.currentTarget.checked })} />
                <span>
                  <b>LaTeX</b> (Tectonic)
                  <small>{t('Un solo programa (≈ 30 MB) que descarga los paquetes que cada documento necesita la primera vez que se compila.', 'A single program (≈ 30 MB) that downloads the packages each document needs the first time it is compiled.')}</small>
                </span>
              </label>
            </Show>
            <Show when={w().packages.length && !w().python && !w().latex}>
              <p class="setup-lead">
                {t(`La celda necesita ${w().packages.join(', ')}, que no está instalado en el Python que usa Pyx (${state.env.python || '—'}). Pyx puede instalarlo ahora; después el kernel se reinicia y hay que volver a ejecutar las celdas.`,
                  `The cell needs ${w().packages.join(', ')}, which is not installed in the Python Pyx uses (${state.env.python || '—'}). Pyx can install it now; the kernel then restarts and the cells must run again.`)}
              </p>
            </Show>
            <Show when={log().length || running()}>
              <div class="setup-log" ref={logEl}>
                <For each={log()}>{(l) => <div>{l}</div>}</For>
                <Show when={running()}><div class="setup-wait">…</div></Show>
              </div>
            </Show>
            <Show when={error()}>
              <div class="setup-error">{error()}</div>
            </Show>
            <Show when={done()}>
              <div class="setup-ok">✓ {t('Listo.', 'Done.')}</div>
            </Show>
          </div>
          <div class="setup-actions">
            <Show when={(w().python || w().latex) && !done()}>
              <button class="setup-link" disabled={running()} onClick={() => { setGeneral({ setupNeverAsk: true }); setOpen(false); }}>
                {t('No volver a preguntar', 'Do not ask again')}
              </button>
            </Show>
            <span style={{ flex: 1 }} />
            <Show when={!done()} fallback={<button class="setup-primary" onClick={() => setOpen(false)}>{t('Cerrar', 'Close')}</button>}>
              <button disabled={running()} onClick={() => setOpen(false)}>{t('Ahora no', 'Not now')}</button>
              <button class="setup-primary" disabled={running() || (!w().python && !w().latex && !w().packages.length)} onClick={start}>
                {running() ? t('Preparando…', 'Working…') : (w().packages.length && !w().python && !w().latex ? t('Instalar', 'Install') : t('Preparar', 'Set up'))}
              </button>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
