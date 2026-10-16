// The kernel's variables — JupyterLab's variable inspector / VS Code's
// "Variables" view, for a calculation report: what each name holds right now,
// its type and size, without printing anything into the document.
//
// Double-click a variable to put `\py{name}` at the cursor: the bridge from
// the calculation to the text is one gesture.

import { createSignal, createEffect, on, For, Show } from 'solid-js';
import { state } from '../../core/state.js';
import { t } from '../../core/i18n.js';
import { listVariables } from '../../editor/cell-runner.js';
import { insertSnippet } from '../../editor/commands.js';

export default function VariablesPanel() {
  const [vars, setVars] = createSignal(null); // null = not read yet
  const [filter, setFilter] = createSignal('');
  const [loading, setLoading] = createSignal(false);

  const refresh = async () => {
    setLoading(true);
    const v = await listVariables();
    if (v) setVars(v); // null (kernel busy or not started): keep what we had
    setLoading(false);
  };

  // Every time the kernel goes back to "ready" — after a cell, a compile, a
  // restart — the list is read again.
  createEffect(on(() => state.kernelStatus, (s) => { if (s === 'ready') refresh(); }));

  const shown = () => {
    const f = filter().trim().toLowerCase();
    const all = vars() || [];
    return f ? all.filter((v) => v.name.toLowerCase().includes(f) || v.type.toLowerCase().includes(f)) : all;
  };

  return (
    <div class="vars-panel">
      <div class="vars-bar">
        <input class="vars-filter" type="search" placeholder={t('Filtrar…', 'Filter…')}
          value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
        <button class="vars-refresh" title={t('Actualizar', 'Refresh')} disabled={loading()}
          onClick={refresh}>⟳</button>
      </div>
      <Show when={state.kernelStatus !== 'idle' || vars()}
        fallback={<div class="side-empty">{t('El kernel no está en marcha. Ejecuta una celda para ver sus variables.', 'The kernel is not running. Run a cell to see its variables.')}</div>}>
        <Show when={shown().length}
          fallback={<div class="side-empty">{vars() ? t('Sin variables.', 'No variables.') : t('Leyendo…', 'Reading…')}</div>}>
          <div class="vars-list">
            <For each={shown()}>
              {(v) => (
                <div class="vars-row"
                  title={`${v.name}: ${v.type}${v.size ? ` (${v.size})` : ''}\n${v.value}\n\n${t('Doble clic: insertar \\py{…} en el cursor', 'Double-click: insert \\py{…} at the cursor')}`}
                  onDblClick={() => insertSnippet(`\\py{${v.name}}`)}>
                  <div class="vars-head">
                    <span class="vars-name">{v.name}</span>
                    <span class="vars-type">{v.type}{v.size ? ` · ${v.size}` : ''}</span>
                  </div>
                  <Show when={v.value}><div class="vars-value">{v.value}</div></Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
