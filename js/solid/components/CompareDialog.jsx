import { createSignal, Show, For } from 'solid-js';
import { t as tr } from '../../core/i18n.js';
import { state, activeDoc } from '../../core/state.js';
import { registerDialog, closeDialogs } from '../stores/dialogStore.js';
import { openFileDialog, writeTextFile, messageDialog } from '../../core/platform.js';
import { baseName, dirOf, joinPath, samePath, stemOf } from '../../core/paths.js';
import { getDocContent } from '../../editor/setup.js';
import { DIFF_STYLES, latexDiff, flatten } from '../../compile/latex-diff.js';

// «Comparar versiones» (Archivo → Revisar): the changes between an older
// version and the document as it is now, as a document of its own — the way
// latexdiff makes one, with nothing to install. The result is written beside
// the main document as <name>-diff.tex, opened and compiled.

const [open, setOpen] = createSignal(false);
registerDialog(open, () => setOpen(false));
export function openCompare() { closeDialogs(); setOpen(true); }

const STYLE_LABEL = () => ({
  UNDERLINE: tr('Subrayado: lo añadido en azul subrayado, lo borrado en rojo tachado', 'Underline: added in blue underlined, deleted in red struck out'),
  CFONT: tr('Solo color y letra (lo más robusto)', 'Colour and font only (the most robust)'),
  CCHANGEBAR: tr('Colores y una barra de cambio en el margen', 'Colours and a change bar in the margin'),
  BOLD: tr('Lo añadido en negrita; lo borrado no se muestra', 'Added in bold; deleted not shown'),
});

/** A file's text: the open document's (unsaved edits included) or the disk's. */
async function textOf(path) {
  const d = state.documents.find((x) => !x.kind && x.path && samePath(x.path, path));
  if (d) return getDocContent(d.id);
  const { readSourceFile } = await import('../../compile/compiler.js');
  return readSourceFile(path);
}
async function diskText(path) {
  const { readSourceFile } = await import('../../compile/compiler.js');
  return readSourceFile(path);
}

function Dialog() {
  const [source, setSource] = createSignal('file'); // 'file' | 'disk'
  const [oldPath, setOldPath] = createSignal('');
  const [style, setStyle] = createSignal('UNDERLINE');
  const [flat, setFlat] = createSignal(true);
  const [cells, setCells] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [msg, setMsg] = createSignal('');

  const pick = async () => {
    const p = await openFileDialog();
    if (typeof p === 'string' && p) setOldPath(p);
  };
  const run = async () => {
    const doc = activeDoc();
    if (!doc || doc.kind || !doc.path) { setMsg(tr('Guarda el documento antes de comparar.', 'Save the document before comparing.')); return; }
    setBusy(true);
    setMsg('');
    try {
      const comp = await import('../../compile/compiler.js');
      const root = (await comp.resolveRootPath(doc, getDocContent(doc.id)).catch(() => doc.path)) || doc.path;
      const newRaw = await textOf(root);
      let oldRaw;
      let oldRoot;
      if (source() === 'disk') { oldRoot = root; oldRaw = await diskText(root); }
      else {
        if (!oldPath()) { setMsg(tr('Elige la versión anterior.', 'Choose the older version.')); setBusy(false); return; }
        oldRoot = oldPath();
        oldRaw = await diskText(oldRoot);
      }
      // --flatten: \input / \include / \subfile expanded on both sides
      const newText = flat() ? await flatten(newRaw, dirOf(root), textOf, joinPath) : newRaw;
      const oldText = flat() ? await flatten(oldRaw, dirOf(oldRoot), source() === 'disk' ? diskText : diskText, joinPath) : oldRaw;
      const { text, stats } = latexDiff(oldText, newText, {
        style: style(),
        cells: cells(),
        labels: {
          title: tr('Cambios en el código Python', 'Changes in the Python code'),
          cell: tr('Celda', 'Cell'), added: tr('nueva', 'new'), deleted: tr('eliminada', 'deleted'), changed: tr('modificada', 'changed'),
        },
      });
      if (!stats.add && !stats.del && !/%DIF Python cells/.test(text)) {
        setMsg(tr('No hay diferencias entre las dos versiones.', 'There are no differences between the two versions.'));
        setBusy(false);
        return;
      }
      const out = joinPath(dirOf(root), `${stemOf(root)}-diff.tex`);
      await writeTextFile(out, text);
      setOpen(false);
      const { openPath } = await import('../stores/docStore.js');
      await openPath(out);
      comp.compileActive(true);
    } catch (e) {
      messageDialog(String((e && e.message) || e), { title: tr('Comparar versiones', 'Compare versions'), kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="cfg-overlay">
      <div class="cfg-modal wz-modal compare-modal">
        <div class="cfg-titlebar">
          <span>{tr('Comparar versiones', 'Compare versions')}</span>
          <button class="cfg-close" title={tr('Cerrar', 'Close')} onClick={() => setOpen(false)}>✕</button>
        </div>
        <div class="wz-body">
          <p class="wz-hint">{tr(
            'Crea un documento con los cambios entre una versión anterior y la actual, como latexdiff: lo añadido y lo borrado, marcados. Usa el preámbulo de la versión nueva y conserva sus celdas de Python; los cambios en el código van al final.',
            'Makes a document with the changes between an older version and the current one, like latexdiff: what was added and deleted, marked. It uses the new version\'s preamble and keeps its Python cells; the changes in the code go at the end.')}</p>
          <div class="wz-row">
            <span class="wz-label">{tr('Versión nueva', 'New version')}</span>
            <span class="compare-file">{activeDoc()?.fileName || '—'}</span>
          </div>
          <div class="wz-row">
            <span class="wz-label">{tr('Versión anterior', 'Older version')}</span>
            <select value={source()} onChange={(e) => setSource(e.target.value)}>
              <option value="file">{tr('Otro archivo (.tex o .pltx)', 'Another file (.tex or .pltx)')}</option>
              <option value="disk">{tr('Lo último guardado en el disco (cambios sin guardar)', 'What was last saved to disk (unsaved changes)')}</option>
            </select>
          </div>
          <Show when={source() === 'file'}>
            <div class="wz-row">
              <span class="wz-label" />
              <input type="text" readOnly value={oldPath() ? baseName(oldPath()) : ''} title={oldPath()} placeholder={tr('ninguno elegido', 'none chosen')} />
              <button class="wz-browse" onClick={pick}>{tr('Elegir…', 'Choose…')}</button>
            </div>
          </Show>
          <div class="wz-row">
            <span class="wz-label">{tr('Estilo', 'Style')}</span>
            <select value={style()} onChange={(e) => setStyle(e.target.value)}>
              <For each={DIFF_STYLES}>{(s) => <option value={s}>{s} — {STYLE_LABEL()[s]}</option>}</For>
            </select>
          </div>
          <div class="wz-row">
            <span class="wz-label">{tr('Varios archivos', 'Several files')}</span>
            <input type="checkbox" checked={flat()} onChange={(e) => setFlat(e.target.checked)} />
            <span class="wz-hint">{tr('expandir \\input, \\include y \\subfile antes de comparar (--flatten)', 'expand \\input, \\include and \\subfile before comparing (--flatten)')}</span>
          </div>
          <div class="wz-row">
            <span class="wz-label">{tr('Código Python', 'Python code')}</span>
            <input type="checkbox" checked={cells()} onChange={(e) => setCells(e.target.checked)} />
            <span class="wz-hint">{tr('añadir los cambios de las celdas al final', 'add the changes of the cells at the end')}</span>
          </div>
          <Show when={msg()}><p class="wz-hint wz-edited">{msg()}</p></Show>
        </div>
        <div class="cfg-footer">
          <button onClick={() => setOpen(false)}>{tr('Cancelar', 'Cancel')}</button>
          <button class="primary" disabled={busy()} onClick={run}>{busy() ? tr('Comparando…', 'Comparing…') : tr('Comparar', 'Compare')}</button>
        </div>
      </div>
    </div>
  );
}

export default function CompareDialog() {
  return <Show when={open()}><Dialog /></Show>;
}
