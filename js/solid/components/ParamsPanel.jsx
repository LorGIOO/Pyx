// "Parámetros": every control of the document in one place — CalcTree's
// parameter panel. Each row is the same control the cell shows (slider,
// input, list, checkbox); changing it rewrites the value in the code and runs
// the cell, and with reactive execution only what depends on it.
//
// A parameter is declared in a cell with a comment:
//     L = 6.0  # @slider(1, 12, 0.5) Luz de la viga (m)

import { createMemo, For, Show, onCleanup, createEffect } from 'solid-js';
import { state, activeDoc } from '../../core/state.js';
import { t } from '../../core/i18n.js';
import { docSnap } from '../stores/structureStore.js';
import { getViewOfDoc } from '../../editor/setup.js';
import { controlsOf, controlDom, setControlValue, runControlCell } from '../../editor/controls.js';
import { gotoLine } from '../../editor/commands.js';

export default function ParamsPanel() {
  const view = () => { const d = activeDoc(); return d ? getViewOfDoc(d.id) : null; };
  const controls = createMemo(() => {
    docSnap(); // recompute when the document changes
    void state.activeIndex;
    const v = view();
    return v ? controlsOf(v.state) : [];
  });

  return (
    <div class="params-panel">
      <Show when={controls().length} fallback={
        <div class="side-empty">
          {t('Este documento no tiene parámetros. Añade un comentario a una asignación de una celda:', 'This document has no parameters. Add a comment to an assignment in a cell:')}
          <pre class="params-example">{'L = 6.0  # @slider(1, 12, 0.5) Luz (m)\nq = 10   # @input Carga (kN/m)\nperfil = "IPE"  # @select("IPE", "HEB")\nfisurada = True  # @check'}</pre>
        </div>
      }>
        <For each={controls()}>
          {(c) => {
            let host;
            const mount = () => {
              if (!host) return;
              host.textContent = '';
              host.appendChild(controlDom(c, {
                onInput: (val) => { const v = view(); if (v) setControlValue(v, c.line, val); },
                onChange: (val) => { const v = view(); if (!v) return; setControlValue(v, c.line, val); runControlCell(v, c.line); },
              }));
            };
            createEffect(mount);
            onCleanup(() => { if (host) host.textContent = ''; });
            return (
              <div class="params-row">
                <div class="params-head" onClick={() => gotoLine(c.line)} title={t(`Ir a la línea ${c.line}`, `Go to line ${c.line}`)}>
                  <span class="params-name">{c.name}</span>
                  <Show when={c.label}><span class="params-label">{c.label}</span></Show>
                </div>
                <div class="params-ctl" ref={(el) => { host = el; mount(); }} />
              </div>
            );
          }}
        </For>
      </Show>
    </div>
  );
}
