import { Show } from 'solid-js';
import { state } from '../../core/state.js';
import { t } from '../../core/i18n.js';
import { wordCount } from '../stores/structureStore.js';
import { icons } from './ribbon/icons.js';
import { cancelCompile } from '../../compile/compiler.js';
import { compileStatus } from '../stores/compileStatus.js';

// The compile item is drawn from compileStatus — the same answer the compile
// LED gives in zen mode, so the two never say different things. Only the
// verdicts get a colour and a glyph; work in progress is plain text.
// codicons: pass, warning, error.
const VERDICT = {
  ok: { color: '#16a34a', icon: icons.pass },
  warn: { color: '#d97706', icon: icons.warn },
  error: { color: '#dc2626', icon: icons.error },
};

// The interpreter is reported as a full path, and a path in a 24px bar pushed
// everything after it — the compile state, Ln/Col — out of a narrow window.
// The bar shows the file; the tooltip has the path. Every Python is called
// python.exe, though, so for those the folder that tells them apart (the
// version directory, the virtualenv) is kept in front of it.
function shortExe(path) {
  if (!path) return '—';
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  const file = parts.pop() || String(path);
  if (!/^python[\d.]*(\.exe)?$/i.test(file)) return file;
  while (parts.length && /^(scripts|bin)$/i.test(parts[parts.length - 1])) parts.pop();
  const dir = parts.pop();
  return dir && !/^[a-z]:$/i.test(dir) ? `${dir} › ${file}` : file;
}

const kernelLabel = () => ({
  idle: t('Kernel inactivo', 'Kernel idle'),
  starting: t('Iniciando kernel…', 'Starting kernel…'),
  ready: t('Kernel listo', 'Kernel ready'),
  busy: t('Ejecutando…', 'Running…'),
  error: t('Kernel: error', 'Kernel: error'),
});

export default function StatusBar() {
  // Word count, TeXstudio-style (prose only). Computed off the typing path (see
  // scheduleDerived) so a thousand-page project never stalls a keystroke.
  const words = wordCount;
  return (
    <div class="status-bar">
      {/* Narrow window: the secondary items step aside one by one (container
          queries in status-bar.css) so the compile state and Ln/Col, at the
          other end, are never the ones pushed out. */}
      <div class="status-item status-kernel" title={kernelLabel()[state.kernelStatus] || state.kernelStatus}>
        <span class={`status-dot ${state.kernelStatus}`}></span>
        <span class="label">{kernelLabel()[state.kernelStatus] || state.kernelStatus}</span>
      </div>

      {/* The formula recognizer at work (image -> LaTeX): it can take a few
          seconds — the first time, as long as its download — and the editor
          stays free meanwhile, so something has to say it is running. */}
      <Show when={state.ocrBusy}>
        <div class="status-item status-ocr" title={state.ocrBusy}>
          <span class="status-dot busy"></span>
          <span class="value">{state.ocrBusy}</span>
        </div>
      </Show>
      <div class="status-item status-path status-python" title={state.env.python || ''}>
        <span class="label">Python:</span>
        <span class="value">{shortExe(state.env.python)}</span>
      </div>
      <div class="status-item status-path status-engine" title={state.env.latex || ''}>
        <span class="label">{t('Motor:', 'Engine:')}</span>
        <span class="value">{shortExe(state.env.latex)}</span>
      </div>
      <Show when={state.missingModules.length}>
        <button class="status-item status-missing" type="button"
          title={t('El documento importa paquetes que este Python no tiene. Pulsa para instalarlos.', 'The document imports packages this Python lacks. Click to install them.')}
          onClick={() => import('./SetupDialog.jsx').then((m) => m.openSetup({ packages: state.missingModules.map(m.pypiName) }))}>
          ⚠ {t('Falta', 'Missing')}: {state.missingModules.join(', ')}
        </button>
      </Show>

      <div class="status-spacer"></div>
      <Show when={state.update}>
        <button class="status-item status-update" type="button" disabled={state.updateBusy}
          title={t(`Hay una versión nueva de Pyx (${state.update.latest}). Pulsa para actualizar.`, `A new Pyx is out (${state.update.latest}). Click to update.`)}
          onClick={() => import('../../core/updates.js').then((m) => m.installUpdate())}>
          {state.updateBusy
            ? t('Descargando actualización…', 'Downloading update…')
            : `⬆ ${t('Actualizar a', 'Update to')} ${state.update.latest}`}
        </button>
      </Show>

      {/* Why the last compile left no new PDF on screen, when it did not.
          Said in words here as well as in the LED's tooltip: "Compilado" with
          a PDF that has not changed is the one thing this bar must never show
          without an explanation. It may be cut short (the tooltip has it
          all); the state next to it may not. */}
      <Show when={state.compileReason && !state.compiling && !state.pdfLoading}>
        <div class="status-item status-reason" title={state.compileReason}>
          <span class="value">{state.compileReason}</span>
        </div>
      </Show>
      <Show when={compileStatus().kind !== 'idle'}>
        <div class="status-item status-keep" title={compileStatus().detail}>
          <span class="value" style={{ color: VERDICT[compileStatus().kind]?.color }}>
            <Show when={VERDICT[compileStatus().kind]}>
              <span class="pyx-ico status-ico" innerHTML={VERDICT[compileStatus().kind].icon}></span>
            </Show>
            {compileStatus().label}
          </span>
          <Show when={state.compiling}>
            <button class="status-btn" type="button"
              title={t('Detener la compilación (se conserva el PDF anterior)', 'Stop compiling (the previous PDF is kept)')}
              onClick={() => cancelCompile()}>
              <span class="pyx-ico status-ico" innerHTML={icons.stop}></span>
            </button>
          </Show>
        </div>
      </Show>

      <div class="status-item status-words" title={t('Palabras del texto (sin comandos, comentarios ni celdas)', 'Words of prose (no commands, comments or cells)')}>
        <span class="value">{words().toLocaleString()}</span>
        <span class="label">{t('palabras', 'words')}</span>
      </div>

      <div class="status-item status-keep">
        <span class="label">Ln</span>
        <span class="value">{state.cursor.line}</span>
        <span class="label">Col</span>
        <span class="value">{state.cursor.col}</span>
      </div>
    </div>
  );
}
