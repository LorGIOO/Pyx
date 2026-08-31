import { Show } from 'solid-js';
import { state } from '../../core/state.js';
import { t } from '../../core/i18n.js';
import { wordCount } from '../stores/structureStore.js';

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
      <div class="status-item">
        <span class={`status-dot ${state.kernelStatus}`}></span>
        <span class="label">{kernelLabel()[state.kernelStatus] || state.kernelStatus}</span>
      </div>

      <div class="status-item">
        <span class="label">Python:</span>
        <span class="value">{state.env.python || '—'}</span>
      </div>
      <div class="status-item">
        <span class="label">{t('Motor:', 'Engine:')}</span>
        <span class="value">{state.env.latex || '—'}</span>
      </div>

      <div class="status-spacer"></div>

      <Show when={state.compiling}>
        <div class="status-item"><span class="value">{t('Compilando…', 'Compiling…')}</span></div>
      </Show>
      <Show when={!state.compiling && state.lastCompileOk === true}>
        <div class="status-item" title={state.compileMs ? `${(state.compileMs / 1000).toFixed(1)} s` : ''}>
          <span class="value" style={{ color: '#16a34a' }}>{t('✓ Compilado', '✓ Compiled')}</span>
        </div>
      </Show>
      {/* A project this heavy is no longer rebuilt on every typing pause — say
          so, instead of leaving the user wondering why the PDF stopped moving. */}
      <Show when={state.liveSuspended && state.liveCompile}>
        <div
          class="status-item"
          title={t(
            'La compilación tarda demasiado para hacerla en cada pausa. Compila cuando quieras con Ctrl+Mayús+B.',
            'This project takes too long to rebuild on every pause. Compile on demand with Ctrl+Shift+B.',
          )}
        >
          <span class="value" style={{ color: '#d97706' }}>
            {t('⏸ Compilación automática en pausa', '⏸ Auto-compile paused')}
          </span>
        </div>
      </Show>
      <Show when={!state.compiling && state.lastCompileOk === false}>
        <div class="status-item"><span class="value" style={{ color: '#dc2626' }}>{t('✗ Error de compilación', '✗ Compilation error')}</span></div>
      </Show>

      <div class="status-item" title={t('Palabras del texto (sin comandos, comentarios ni celdas)', 'Words of prose (no commands, comments or cells)')}>
        <span class="value">{words().toLocaleString()}</span>
        <span class="label">{t('palabras', 'words')}</span>
      </div>

      <div class="status-item">
        <span class="label">Ln</span>
        <span class="value">{state.cursor.line}</span>
        <span class="label">Col</span>
        <span class="value">{state.cursor.col}</span>
      </div>
    </div>
  );
}
