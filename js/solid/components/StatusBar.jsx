import { Show } from 'solid-js';
import { state } from '../../core/state.js';
import { t } from '../../core/i18n.js';

const kernelLabel = () => ({
  idle: t('Kernel inactivo', 'Kernel idle'),
  starting: t('Iniciando kernel…', 'Starting kernel…'),
  ready: t('Kernel listo', 'Kernel ready'),
  busy: t('Ejecutando…', 'Running…'),
  error: t('Kernel: error', 'Kernel: error'),
});

export default function StatusBar() {
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
        <div class="status-item"><span class="value" style={{ color: '#16a34a' }}>{t('✓ Compilado', '✓ Compiled')}</span></div>
      </Show>
      <Show when={!state.compiling && state.lastCompileOk === false}>
        <div class="status-item"><span class="value" style={{ color: '#dc2626' }}>{t('✗ Error de compilación', '✗ Compilation error')}</span></div>
      </Show>

      <div class="status-item">
        <span class="label">Ln</span>
        <span class="value">{state.cursor.line}</span>
        <span class="label">Col</span>
        <span class="value">{state.cursor.col}</span>
      </div>
    </div>
  );
}
