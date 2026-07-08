import { Show } from 'solid-js';
import { state } from '../../core/state.js';

const KERNEL_LABEL = {
  idle: 'Kernel inactivo',
  starting: 'Iniciando kernel…',
  ready: 'Kernel listo',
  busy: 'Ejecutando…',
  error: 'Kernel: error',
};

export default function StatusBar() {
  return (
    <div class="status-bar">
      <div class="status-item">
        <span class={`status-dot ${state.kernelStatus}`}></span>
        <span class="label">{KERNEL_LABEL[state.kernelStatus] || state.kernelStatus}</span>
      </div>

      <div class="status-item">
        <span class="label">Python:</span>
        <span class="value">{state.env.python || '—'}</span>
      </div>
      <div class="status-item">
        <span class="label">Motor:</span>
        <span class="value">{state.env.latex || '—'}</span>
      </div>

      <div class="status-spacer"></div>

      <Show when={state.compiling}>
        <div class="status-item"><span class="value">Compilando…</span></div>
      </Show>
      <Show when={!state.compiling && state.lastCompileOk === true}>
        <div class="status-item"><span class="value" style={{ color: '#16a34a' }}>✓ Compilado</span></div>
      </Show>
      <Show when={!state.compiling && state.lastCompileOk === false}>
        <div class="status-item"><span class="value" style={{ color: '#dc2626' }}>✗ Error de compilación</span></div>
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
