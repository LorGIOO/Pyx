// Editor of the user's Python macros (macros.js).

import { createSignal, For, Show } from 'solid-js';
import { t } from '../../core/i18n.js';
import { getMacros, saveMacros, runMacro, showMacroResult, DEFAULT_MACROS } from '../../editor/macros.js';
import { registerDialog, closeDialogs } from '../stores/dialogStore.js';

const [open, setOpen] = createSignal(false);
registerDialog(open, () => setOpen(false));
export const openMacros = () => { closeDialogs(); setOpen(true); };

export default function MacrosDialog() {
  const [list, setList] = createSignal(getMacros().map((m) => ({ ...m })));
  const [sel, setSel] = createSignal(0);
  const cur = () => list()[sel()];
  const update = (patch) => {
    const l = list().slice();
    l[sel()] = { ...l[sel()], ...patch };
    setList(l);
    saveMacros(l);
  };
  const add = () => {
    const l = [...list(), { name: t('Nueva macro', 'New macro'), code: 'resultado = seleccion' }];
    setList(l); saveMacros(l); setSel(l.length - 1);
  };
  const remove = () => {
    const l = list().filter((_, i) => i !== sel());
    setList(l); saveMacros(l); setSel(Math.max(0, sel() - 1));
  };
  const reset = () => {
    if (!window.confirm(t('¿Volver a las macros de ejemplo? Se pierden las tuyas.', 'Restore the example macros? Yours are lost.'))) return;
    const l = DEFAULT_MACROS.map((m) => ({ ...m }));
    setList(l); saveMacros(l); setSel(0);
  };
  return (
    <Show when={open()}>
      <div class="cfg-overlay">
        <div class="cfg-modal macros-modal">
          <div class="cfg-titlebar">
            <span>{t('Macros en Python', 'Python macros')}</span>
            <button class="cfg-close" title={t('Cerrar', 'Close')} onClick={() => setOpen(false)}>✕</button>
          </div>
          <div class="macros-body">
            <div class="macros-list">
              <For each={list()}>
                {(m, i) => (
                  <div class="macros-item" classList={{ active: i() === sel() }} onClick={() => setSel(i())}>
                    <span class="macros-key">{i() < 9 ? `Alt+Mayús+${i() + 1}` : ''}</span>
                    <span>{m.name}</span>
                  </div>
                )}
              </For>
              <div class="macros-list-actions">
                <button onClick={add}>＋ {t('Nueva', 'New')}</button>
                <button onClick={reset}>{t('Ejemplos', 'Examples')}</button>
              </div>
            </div>
            <Show when={cur()} fallback={<div class="macros-edit side-empty">{t('Sin macros.', 'No macros.')}</div>}>
              <div class="macros-edit">
                <input class="cfg-select macros-name" value={cur().name} onInput={(e) => update({ name: e.currentTarget.value })} />
                <textarea class="macros-code" spellcheck={false} value={cur().code}
                  onInput={(e) => update({ code: e.currentTarget.value })} />
                <p class="cfg-hint">
                  {t('Variables: seleccion (el texto seleccionado), texto (todo el documento), linea (la del cursor) y variables (las del documento, solo lectura). Lo que dejes en resultado sustituye a la selección; print() se muestra en un aviso.',
                    'Variables: seleccion (the selected text), texto (the whole document), linea (the cursor\'s line) and variables (the document\'s, read-only). What you leave in resultado replaces the selection; print() is shown in a notice.')}
                </p>
                <div class="macros-actions">
                  <button class="danger" onClick={remove}>{t('Eliminar', 'Delete')}</button>
                  <span style={{ flex: 1 }} />
                  <button class="setup-primary" onClick={() => runMacro(cur()).then(showMacroResult)}>{t('Ejecutar', 'Run')}</button>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
