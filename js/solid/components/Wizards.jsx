import { createSignal, createMemo, createEffect, onCleanup, Show, For, Index } from 'solid-js';
import { insertSnippet } from '../../editor/commands.js';
import { openImageDialog, readBinaryFile } from '../../core/platform.js';
import { relativePath, joinPath, baseName } from '../../core/paths.js';
import { activeRootDir } from '../../compile/compiler.js';
import { parseTsv, parseHtmlTable, tableRules } from '../../editor/paste-table.js';
import {
  tableLatex, tablePackages, figureLatex, figurePackages, slugLabel, tableParts, figureParts,
} from '../../editor/table-gen.js';
import {
  templates, loadTemplates, saveTemplate, deleteTemplate, fillTemplate, templatize, PLACEHOLDERS,
} from '../stores/templatesStore.js';
import { userDir } from '../../core/userfiles.js';
import { revealInExplorer, askDialog } from '../../core/platform.js';
import { getDocContent } from '../../editor/setup.js';
import { activeDoc } from '../../core/state.js';
import { registerDialog, closeDialogs } from '../stores/dialogStore.js';
import { general, setGeneral } from '../stores/settingsStore.js';
import { t as tr } from '../../core/i18n.js';

/* «Mi estilo»: the options of each assistant the user saved as their own.
   A new table or figure starts from them instead of the built-in defaults;
   content (cells, images, titles, labels) is never part of a style. */
const savedStyle = (key) => {
  const v = general[key];
  return v && typeof v === 'object' ? v : {};
};
const pick = (o, k, fallback, ok = () => true) => (o[k] !== undefined && ok(o[k]) ? o[k] : fallback);
const isOneOf = (...list) => (v) => list.includes(v);
const isBool = (v) => typeof v === 'boolean';
const isNum = (lo, hi) => (v) => typeof v === 'number' && v >= lo && v <= hi;

/** The two buttons every assistant shows: save the current look as «my
 *  style», or go back to Pyx's defaults. */
function StyleButtons(props) {
  const [msg, setMsg] = createSignal('');
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 2200); };
  return (
    <div class="wz-style">
      <button class="wz-browse" title={tr('Las próximas tablas o figuras empezarán con estas opciones (no se guarda el contenido)', 'The next tables or figures will start with these options (the content is not saved)')}
        onClick={() => { setGeneral({ [props.key]: props.get() }); flash(tr('Guardado como tu estilo', 'Saved as your style')); }}>{tr('Guardar opciones como mi estilo', 'Save options as my style')}</button>
      <button class="wz-browse" title={tr('Volver a las opciones de Pyx', 'Back to Pyx\'s options')} disabled={!Object.keys(savedStyle(props.key)).length}
        onClick={() => { setGeneral({ [props.key]: null }); props.reset(); flash(tr('Estilo de Pyx restablecido', 'Pyx style restored')); }}>{tr('Opciones de Pyx', 'Pyx options')}</button>
      <span class="wz-hint">{msg()}</span>
    </div>
  );
}

// Stand-ins for an empty caption / label while a template is being made.
const SENT_CAP = '\u0001caption\u0001';
const SENT_LAB = '\u0001label\u0001';

/** The template library of an assistant: pick one (or Pyx's own options),
 *  save the code on screen as a new one, delete one, make one the default,
 *  open the folder. Templates are .tex files (stores/templatesStore.js). */
function TemplateBar(props) {
  const [naming, setNaming] = createSignal(false);
  const [name, setName] = createSignal('');
  const [msg, setMsg] = createSignal('');
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2600); };
  const defKey = props.kind === 'tables' ? 'tableTemplate' : 'figureTemplate';
  const isDefault = () => !!props.selected() && (general[defKey] || '') === props.selected();
  const save = async () => {
    const n = name().trim();
    if (!n) return;
    await saveTemplate(props.kind, n, props.templateText());
    props.setSelected(n);
    props.discard();
    setNaming(false); setName('');
    flash(tr(`Plantilla «${n}» guardada`, `Template “${n}” saved`));
  };
  const remove = async () => {
    const n = props.selected();
    if (!n) return;
    if (!(await askDialog(tr(`¿Eliminar la plantilla «${n}»?`, `Delete the template “${n}”?`), { title: tr('Plantillas', 'Templates'), kind: 'warning' }))) return;
    await deleteTemplate(props.kind, n);
    if ((general[defKey] || '') === n) setGeneral({ [defKey]: '' });
    props.setSelected('');
  };
  const folder = async () => {
    const d = await userDir();
    if (d) revealInExplorer(`${d}${d.includes('\\') ? '\\' : '/'}templates${d.includes('\\') ? '\\' : '/'}${props.kind}`);
  };
  return (
    <div class="wz-tpl">
      <span class="wz-label">{tr('Plantilla', 'Template')}</span>
      <select value={props.selected()} onChange={(e) => { props.setSelected(e.target.value); props.discard(); }}>
        <option value="">{tr('Opciones de este asistente', 'This assistant\'s options')}</option>
        <For each={templates(props.kind)}>{(tp) => <option value={tp.name}>{tp.name}</option>}</For>
      </select>
      <button class={`wz-browse wz-star${isDefault() ? ' on' : ''}`} disabled={!props.selected() && !general[defKey]} title={tr('Usar siempre al abrir el asistente (y al arrastrar archivos)', 'Always use when the assistant opens (and when files are dropped)')}
        onClick={() => setGeneral({ [defKey]: isDefault() ? '' : props.selected() })}>{isDefault() ? '★' : '☆'} {tr('Por defecto', 'Default')}</button>
      <Show when={!naming()} fallback={
        <>
          <input type="text" class="wz-tpl-name" placeholder={tr('Nombre de la plantilla', 'Template name')} value={name()}
            ref={(el) => requestAnimationFrame(() => el.focus())}
            onInput={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); setNaming(false); } }} />
          <button class="wz-browse" disabled={!name().trim()} onClick={save}>{tr('Guardar', 'Save')}</button>
        </>
      }>
        <button class="wz-browse" title={tr('Guarda el código de abajo (con tus cambios) como plantilla de la biblioteca', 'Save the code below (with your changes) as a library template')}
          onClick={() => { setName(props.selected() || ''); setNaming(true); }}>{tr('Guardar como plantilla…', 'Save as template…')}</button>
      </Show>
      <button class="wz-browse" disabled={!props.selected()} title={tr('Eliminar la plantilla elegida', 'Delete the chosen template')} onClick={remove}>{tr('Eliminar', 'Delete')}</button>
      <button class="wz-browse" title={tr('Abrir la carpeta de las plantillas', 'Open the templates folder')} onClick={folder}>{tr('Carpeta', 'Folder')}</button>
      <span class="wz-hint">{msg()}</span>
    </div>
  );
}

/** What «Insertar» writes: editable. Edited by hand, it stays as written
 *  until «Descartar cambios»; the placeholders a template may use are listed. */
function CodeBox(props) {
  return (
    <>
      <textarea class="wz-code" spellcheck={false} value={props.edited() ?? props.code()}
        onInput={(e) => props.setEdited(e.target.value)} rows={9} />
      <div class="wz-codebar">
        <Show when={props.edited() != null} fallback={
          <span class="wz-hint">{tr('Puedes editar el código a mano antes de insertarlo o de guardarlo como plantilla. Marcadores:', 'You can edit the code by hand before inserting it or saving it as a template. Placeholders:')} <code>{PLACEHOLDERS[props.kind].map((p) => `{{${p}}}`).join(' ')}</code></span>
        }>
          <span class="wz-hint wz-edited">{tr('Código editado a mano: los cambios de arriba ya no lo actualizan.', 'Code edited by hand: the options above no longer update it.')}</span>
          <button class="wz-browse" onClick={() => props.setEdited(null)}>{tr('Descartar cambios', 'Discard changes')}</button>
        </Show>
      </div>
    </>
  );
}

// Table & figure assistants: movable dialogs (the Configuración chrome) where
// the table is FILLED IN — typed, or pasted from a spreadsheet — and the
// figure is seen before it is inserted. Both show the LaTeX they will write
// (editor/table-gen.js), so there is no guessing what "Insertar" does.

const [tableOpen, setTableOpen] = createSignal(false);
const [figureOpen, setFigureOpen] = createSignal(false);
// A path to start the figure with (a dropped or inserted image).
let figureStartPath = '';
// Opening one closes any other dialog, and Escape closes it (dialogStore).
export const openTableWizard = () => { closeDialogs(); loadTemplates('tables'); setTableOpen(true); };
export const openFigureWizard = (path) => {
  closeDialogs();
  figureStartPath = typeof path === 'string' ? path : '';
  loadTemplates('figures');
  setFigureOpen(true);
};
registerDialog(tableOpen, () => setTableOpen(false));
registerDialog(figureOpen, () => setFigureOpen(false));

function useDrag() {
  const [pos, setPos] = createSignal(null);
  const startDrag = (e) => {
    if (e.target.closest('.cfg-close')) return;
    e.preventDefault();
    const rect = e.currentTarget.parentElement.getBoundingClientRect();
    const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
    const move = (ev) => setPos({ x: ev.clientX - offX, y: ev.clientY - offY });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return [pos, startDrag];
}

// A <div>, not a <label>: a row can hold two controls (a checkbox and its
// companion), and a label would hand every click on the row to the first.
const Field = (props) => (
  <div class="wz-row" title={props.title}>
    <span class="wz-label">{props.label}</span>
    {props.children}
  </div>
);

const FLOATS = () => [
  ['htbp', tr('Donde mejor quepa [htbp]', 'Wherever it fits best [htbp]')],
  ['H', tr('Exactamente aquí [H]', 'Exactly here [H]')],
  ['t', tr('Arriba de la página [t]', 'Top of the page [t]')],
  ['b', tr('Abajo de la página [b]', 'Bottom of the page [b]')],
  ['p', tr('En página aparte [p]', 'On a page of its own [p]')],
];

/** The note under the code: what the document must load for it to compile. */
const Needs = (props) => (
  <Show when={props.list.length}>
    <div class="wz-needs">
      {tr('Requiere en el preámbulo:', 'Needs in the preamble:')} {props.list.map((p) => `\\usepackage{${p}}`).join('  ')}
    </div>
  </Show>
);

/* ---------------- Tabla ---------------- */
const MAX_ROWS = 60, MAX_COLS = 16;

function TableWizard() {
  const [pos, startDrag] = useDrag();
  // The grid: rows of cell texts. One signal for the whole grid — a table
  // this size re-renders in well under a frame.
  const [cells, setCells] = createSignal([
    [tr('Columna 1', 'Column 1'), tr('Columna 2', 'Column 2'), tr('Columna 3', 'Column 3')],
    ['', '', ''],
    ['', '', ''],
  ]);
  const st = savedStyle('tableStyle');
  const autoRules = () => tableRules(activeDoc() ? getDocContent(activeDoc().id) : '');
  const ALIGNS = isOneOf('l', 'c', 'r', 'p');
  const defAlign = pick(st, 'align', 'l', ALIGNS);
  const [align, setAlign] = createSignal([defAlign, defAlign, defAlign]);
  const [rules, setRules] = createSignal(pick(st, 'rules', null, isOneOf('booktabs', 'hline', 'grid', 'none')) || autoRules());
  const [vlines, setVlines] = createSignal(pick(st, 'vlines', false, isBool));
  const [header, setHeader] = createSignal(pick(st, 'header', true, isBool));
  const [headerBold, setHeaderBold] = createSignal(pick(st, 'headerBold', true, isBool));
  const [escape, setEscape] = createSignal(pick(st, 'escape', true, isBool));
  const [float, setFloat] = createSignal(pick(st, 'float', 'htbp', isOneOf('htbp', 'H', 't', 'b', 'p', 'none')));
  const [caption, setCaption] = createSignal('');
  const [captionPos, setCaptionPos] = createSignal(pick(st, 'captionPos', 'top', isOneOf('top', 'bottom')));
  const [label, setLabel] = createSignal('');
  const [size, setSize] = createSignal(pick(st, 'size', '', isOneOf('', 'small', 'footnotesize', 'scriptsize')));
  const [fit, setFit] = createSignal(pick(st, 'fit', false, isBool));
  const [pWidth, setPWidth] = createSignal(pick(st, 'pWidth', '3cm', (v) => typeof v === 'string' && v.length < 20));
  const styleNow = () => ({
    align: align()[0], rules: rules(), vlines: vlines(), header: header(), headerBold: headerBold(), escape: escape(),
    float: float(), captionPos: captionPos(), size: size(), fit: fit(), pWidth: pWidth(),
  });
  const resetStyle = () => {
    setAlign(align().map(() => 'l')); setRules(autoRules()); setVlines(false); setHeader(true); setHeaderBold(true);
    setEscape(true); setFloat('htbp'); setCaptionPos('top'); setSize(''); setFit(false); setPWidth('3cm');
  };
  let gridEl;

  const nRows = () => cells().length;
  const nCols = () => cells()[0].length;
  const resize = (r, c) => {
    r = Math.max(1, Math.min(MAX_ROWS, r | 0));
    c = Math.max(1, Math.min(MAX_COLS, c | 0));
    setCells(Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => (cells()[i] && cells()[i][j]) || '')));
    setAlign(Array.from({ length: c }, (_, j) => align()[j] || defAlign));
  };
  const setCell = (i, j, v) => setCells(cells().map((r, ri) => (ri === i ? r.map((c, ci) => (ci === j ? v : c)) : r)));
  const setColAlign = (j, v) => setAlign(align().map((a, k) => (k === j ? v : a)));
  const focusCell = (i, j) => {
    const el = gridEl && gridEl.querySelector(`[data-cell="${i}:${j}"]`);
    if (el) { el.focus(); el.select(); }
  };

  /** Paste into the grid: a block copied from a spreadsheet (or a table of a
   *  web page) fills the cells from the one under the caret, and the grid
   *  grows to hold it. Plain text with no table in it pastes into the cell. */
  const onPaste = (e, i, j) => {
    const data = e.clipboardData;
    if (!data) return;
    const html = data.getData('text/html') || '';
    const text = (data.getData('text/plain') || '').replace(/\r\n?/g, '\n');
    let block = parseTsv(text);
    const hrows = html ? parseHtmlTable(html) : null;
    if (!block && hrows && hrows.length > 1) block = hrows.map((r) => r.flatMap((c) => [c.text, ...Array(c.span - 1).fill('')]));
    else if (block && hrows && hrows.length === block.length) block = hrows.map((r) => r.flatMap((c) => [c.text, ...Array(c.span - 1).fill('')]));
    if (!block) return; // one cell's worth of text: the input takes it
    e.preventDefault();
    const rowsNeeded = Math.min(MAX_ROWS, i + block.length);
    const colsNeeded = Math.min(MAX_COLS, j + Math.max(...block.map((r) => r.length)));
    const r = Math.max(nRows(), rowsNeeded), c = Math.max(nCols(), colsNeeded);
    const next = Array.from({ length: r }, (_, ri) => Array.from({ length: c }, (_, ci) => (cells()[ri] && cells()[ri][ci]) || ''));
    block.forEach((row, bi) => row.forEach((val, bj) => {
      if (i + bi < r && j + bj < c) next[i + bi][j + bj] = String(typeof val === 'string' ? val : (val && val.text) || '').trim();
    }));
    setCells(next);
    // Numbers to the right, like the paste into the document does.
    const NUM = /^[-+−]?(\d{1,3}([.,  ]\d{3})*|\d+)([.,]\d+)?([eE][-+]?\d+)?\s*%?$/;
    setAlign(Array.from({ length: c }, (_, cj) => {
      if (cj < j || cj >= j + block[0].length) return align()[cj] || 'l';
      const vals = next.slice(header() ? 1 : 0).map((row) => row[cj]).filter((v) => v.trim());
      return vals.length && vals.every((v) => NUM.test(v.trim())) ? 'r' : (align()[cj] || 'l');
    }));
  };
  const onKey = (e, i, j) => {
    if (e.key === 'Enter') { e.preventDefault(); if (i + 1 >= nRows()) resize(nRows() + 1, nCols()); queueMicrotask(() => focusCell(i + 1, j)); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); focusCell(Math.min(nRows() - 1, i + 1), j); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusCell(Math.max(0, i - 1), j); }
  };

  const options = () => ({
    cells: cells(), align: align(), pWidth: pWidth(), rules: rules(), vlines: vlines(), header: header(),
    headerBold: headerBold(), escape: escape(), float: float(), caption: caption().trim(), captionPos: captionPos(),
    label: label().trim(), size: size(), fit: fit(),
  });
  // A library template, or this assistant's own options ('').
  const [tpl, setTpl] = createSignal(general.tableTemplate || '');
  const [edited, setEdited] = createSignal(null);
  const tplText = () => (templates('tables').find((x) => x.name === tpl()) || {}).text;
  const parts = () => tableParts(options());
  const code = createMemo(() => (tpl() && tplText() != null ? fillTemplate(tplText(), parts()) : tableLatex(options())));
  const usingTpl = () => !!(tpl() && tplText() != null);
  const insert = () => { insertSnippet((edited() ?? code()) + '\n'); setTableOpen(false); };
  // «Guardar como plantilla»: the code on screen with Pyx's pieces turned back
  // into {{placeholders}}.
  const templateText = () => {
    if (edited() != null) return templatize(edited(), parts());
    // Not edited: an empty caption or label still gets its line in the template.
    const p = { ...parts(), caption: parts().caption || SENT_CAP, label: parts().label || SENT_LAB };
    return templatize(usingTpl() ? fillTemplate(tplText(), p) : tableLatex({ ...options(), caption: p.caption, label: p.label }), p);
  };

  return (
    <div class="cfg-overlay">
      <div class="cfg-modal wz-modal wz-wide" style={pos() ? { left: pos().x + 'px', top: pos().y + 'px', transform: 'none' } : undefined}>
        <div class="cfg-titlebar" onPointerDown={startDrag}>
          <span>{tr('Asistente de tabla', 'Table assistant')}</span>
          <button class="cfg-close" title={tr('Cerrar', 'Close')} onClick={() => setTableOpen(false)}>✕</button>
        </div>
        <div class="wz-body">
          <TemplateBar kind="tables" selected={tpl} setSelected={setTpl} templateText={templateText} discard={() => setEdited(null)} />
          <div class="wz-toolbar">
            <Field label={tr('Filas', 'Rows')}><input type="number" min="1" max={MAX_ROWS} value={nRows()} onChange={(e) => resize(+e.target.value, nCols())} /></Field>
            <Field label={tr('Columnas', 'Columns')}><input type="number" min="1" max={MAX_COLS} value={nCols()} onChange={(e) => resize(nRows(), +e.target.value)} /></Field>
            <span class="wz-hint wz-grow">{tr(<>Escribe en las celdas o <b>pega aquí las celdas copiadas de Excel</b>: la tabla se rellena y crece sola. Intro baja de fila.</>, <>Type in the cells or <b>paste here the cells copied from Excel</b>: the table fills and grows by itself. Enter goes down a row.</>)}</span>
          </div>
          <div class="wz-grid-wrap">
            <table class="wz-grid" ref={gridEl}>
              <thead>
                <tr>
                  <Index each={align()}>
                    {(a, j) => (
                      <th>
                        <select value={a()} title={tr('Alineación de la columna', 'Column alignment')} onChange={(e) => setColAlign(j, e.target.value)}>
                          <option value="l">{tr('⇤ izq.', '⇤ left')}</option>
                          <option value="c">{tr('↔ centro', '↔ centre')}</option>
                          <option value="r">{tr('⇥ der.', '⇥ right')}</option>
                          <option value="p">{tr('¶ párrafo', '¶ paragraph')}</option>
                        </select>
                      </th>
                    )}
                  </Index>
                </tr>
              </thead>
              <tbody>
                <Index each={cells()}>
                  {(row, i) => (
                    <tr classList={{ 'wz-head': header() && i === 0 }}>
                      <Index each={row()}>
                        {(cell, j) => (
                          <td>
                            <input type="text" data-cell={`${i}:${j}`} value={cell()} spellcheck={false}
                              onInput={(e) => setCell(i, j, e.target.value)}
                              onPaste={(e) => onPaste(e, i, j)} onKeyDown={(e) => onKey(e, i, j)} />
                          </td>
                        )}
                      </Index>
                    </tr>
                  )}
                </Index>
              </tbody>
            </table>
          </div>
          <div class="wz-cols">
            <div class="wz-col">
              <Field label={tr('Líneas', 'Rules')}>
                <select value={rules()} onChange={(e) => setRules(e.target.value)}>
                  <option value="booktabs">{tr('booktabs (profesional)', 'booktabs (professional)')}</option>
                  <option value="hline">{tr('\\hline arriba, bajo la cabecera y abajo', '\\hline at top, under the header and at bottom')}</option>
                  <option value="grid">{tr('Cuadrícula completa', 'Full grid')}</option>
                  <option value="none">{tr('Sin líneas', 'No rules')}</option>
                </select>
              </Field>
              <Field label={tr('Cabecera', 'Header')}>
                <input type="checkbox" checked={header()} onChange={(e) => setHeader(e.target.checked)} />
                <span class="wz-hint">{tr('la primera fila', 'the first row')}</span>
                <input type="checkbox" checked={headerBold()} disabled={!header()} onChange={(e) => setHeaderBold(e.target.checked)} />
                <span class="wz-hint">{tr('en negrita', 'in bold')}</span>
              </Field>
              <Field label={tr('Líneas verticales', 'Vertical rules')} title={tr('No se recomiendan con booktabs', 'Not recommended with booktabs')}>
                <input type="checkbox" checked={vlines()} onChange={(e) => setVlines(e.target.checked)} />
              </Field>
              <Field label={tr('Celdas de texto', 'Text cells')} title={tr('Escapa % & _ # $ { } en las celdas. Desactívalo si escribes LaTeX en ellas ($x^2$, \\textbf{…}).', 'Escapes % & _ # $ { } in the cells. Turn it off if you write LaTeX in them ($x^2$, \\textbf{…}).')}>
                <input type="checkbox" checked={escape()} onChange={(e) => setEscape(e.target.checked)} />
                <span class="wz-hint">{tr('escapar % & _ $ … (quítalo si escribes LaTeX)', 'escape % & _ $ … (untick it if you write LaTeX)')}</span>
              </Field>
              <Show when={align().includes('p')}>
                <Field label={tr('Ancho de ¶', '¶ width')}><input type="text" value={pWidth()} onInput={(e) => setPWidth(e.target.value)} placeholder="3cm" /></Field>
              </Show>
            </div>
            <div class="wz-col">
              <Field label={tr('Colocación', 'Placement')}>
                <select value={float()} onChange={(e) => setFloat(e.target.value)}>
                  <For each={FLOATS()}>{(f) => <option value={f[0]}>{f[1]}</option>}</For>
                  <option value="none">{tr('Solo el tabular (sin entorno table)', 'Only the tabular (no table environment)')}</option>
                </select>
              </Field>
              <Field label={tr('Título', 'Caption')}>
                <input type="text" value={caption()} disabled={float() === 'none'} onInput={(e) => setCaption(e.target.value)} placeholder={tr('Descripción de la tabla', 'Description of the table')} />
                <select class="wz-short" value={captionPos()} disabled={float() === 'none'} onChange={(e) => setCaptionPos(e.target.value)}>
                  <option value="top">{tr('arriba', 'above')}</option>
                  <option value="bottom">{tr('abajo', 'below')}</option>
                </select>
              </Field>
              <Field label={tr('Etiqueta', 'Label')}>
                <input type="text" value={label()} disabled={float() === 'none'} onInput={(e) => setLabel(e.target.value)} placeholder={tr('mi-tabla → \\ref{tab:mi-tabla}', 'my-table → \\ref{tab:my-table}')} />
                <button class="wz-browse" disabled={float() === 'none' || !caption().trim()} title={tr('Proponer una etiqueta a partir del título', 'Suggest a label from the caption')}
                  onClick={(e) => { e.preventDefault(); setLabel(slugLabel(caption())); }}>{tr('Del título', 'From the caption')}</button>
              </Field>
              <Field label={tr('Tamaño de letra', 'Font size')}>
                <select value={size()} onChange={(e) => setSize(e.target.value)}>
                  <option value="">{tr('Normal', 'Normal')}</option>
                  <option value="small">{tr('Pequeña (\\small)', 'Small (\\small)')}</option>
                  <option value="footnotesize">{tr('Más pequeña (\\footnotesize)', 'Smaller (\\footnotesize)')}</option>
                  <option value="scriptsize">{tr('Mínima (\\scriptsize)', 'Smallest (\\scriptsize)')}</option>
                </select>
              </Field>
              <Field label={tr('Si no cabe', 'If it does not fit')} title={tr('Reduce la tabla al ancho del texto solo cuando es más ancha', 'Shrinks the table to the text width only when it is wider')}>
                <input type="checkbox" checked={fit()} onChange={(e) => setFit(e.target.checked)} />
                <span class="wz-hint">{tr('reducirla al ancho del texto', 'shrink it to the text width')}</span>
              </Field>
            </div>
          </div>
          <CodeBox kind="tables" code={code} edited={edited} setEdited={setEdited} />
          <Show when={!usingTpl()}><Needs list={tablePackages(options())} /></Show>
          <Show when={!usingTpl()}><StyleButtons key="tableStyle" get={styleNow} reset={resetStyle} /></Show>
        </div>
        <div class="cfg-footer">
          <button onClick={() => setTableOpen(false)}>{tr('Cancelar', 'Cancel')}</button>
          <button class="primary" onClick={insert}>{tr('Insertar tabla', 'Insert table')}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Figura ---------------- */
const RASTER = /\.(png|jpe?g|gif|bmp|webp|svg)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };

/** A small look at the image a row names (a PDF or EPS has none to show). */
function Thumb(props) {
  const [url, setUrl] = createSignal('');
  let made = '';
  const drop = () => { if (made) { URL.revokeObjectURL(made); made = ''; } };
  createEffect(() => {
    const path = props.path, root = props.root;
    drop();
    setUrl('');
    if (!path || !RASTER.test(path)) return;
    const abs = /^([a-zA-Z]:[\\/]|[\\/])/.test(path) ? path : (root ? joinPath(root, path) : null);
    if (!abs) return;
    readBinaryFile(abs).then((bytes) => {
      if (props.path !== path) return; // the row names another file by now
      const ext = path.split('.').pop().toLowerCase();
      made = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] || 'application/octet-stream' }));
      setUrl(made);
    }).catch(() => {});
  });
  onCleanup(drop);
  return (
    <div class="wz-thumb" title={props.path}>
      <Show when={url()} fallback={<span>{props.path ? (RASTER.test(props.path) ? '…' : (props.path.split('.').pop() || '').toUpperCase()) : '—'}</span>}>
        <img src={url()} alt="" />
      </Show>
    </div>
  );
}

function FigureWizard() {
  const [pos, startDrag] = useDrag();
  const [images, setImages] = createSignal([{ path: figureStartPath || '', caption: '' }]);
  const st = savedStyle('figureStyle');
  const [unit, setUnit] = createSignal(pick(st, 'unit', 'textwidth', isOneOf('textwidth', 'cm', 'natural')));
  const [width, setWidth] = createSignal(pick(st, 'width', 0.8, isNum(0.05, 1)));
  const [widthCm, setWidthCm] = createSignal(pick(st, 'widthCm', 10, isNum(0.5, 40)));
  const [height, setHeight] = createSignal(pick(st, 'height', 0, isNum(0, 40)));
  const [angle, setAngle] = createSignal(0);
  const [perRow, setPerRow] = createSignal(pick(st, 'perRow', 2, isNum(1, 4)));
  const [float, setFloat] = createSignal(pick(st, 'float', 'htbp', isOneOf('htbp', 'H', 't', 'b', 'p', 'none')));
  const [centered, setCentered] = createSignal(pick(st, 'centered', true, isBool));
  const [caption, setCaption] = createSignal('');
  const [captionPos, setCaptionPos] = createSignal(pick(st, 'captionPos', 'bottom', isOneOf('top', 'bottom')));
  const styleNow = () => ({
    unit: unit(), width: width(), widthCm: widthCm(), height: height(), perRow: perRow(), float: float(),
    centered: centered(), captionPos: captionPos(),
  });
  const resetStyle = () => {
    setUnit('textwidth'); setWidth(0.8); setWidthCm(10); setHeight(0); setPerRow(2); setFloat('htbp');
    setCentered(true); setCaptionPos('bottom');
  };
  const [label, setLabel] = createSignal('');
  // LaTeX resolves an image from the folder of the ROOT document, also when
  // the figure is written in a chapter: that is the folder paths are made
  // relative to (and the one a relative path typed here is read from).
  const [root, setRoot] = createSignal('');
  activeRootDir().then((d) => setRoot(d || '')).catch(() => {});

  const setImage = (i, patch) => setImages(images().map((im, k) => (k === i ? { ...im, ...patch } : im)));
  const browse = async (i) => {
    const p = await openImageDialog();
    if (!p) return;
    const rel = relativePath(root(), String(p));
    setImage(i, { path: rel });
    if (!label().trim() && i === 0) setLabel(slugLabel(baseName(rel)));
  };
  const many = () => images().filter((im) => im.path.trim()).length > 1;

  const options = () => ({
    images: images(), unit: unit(), width: unit() === 'cm' ? widthCm() : width(), height: height(), angle: angle(),
    perRow: perRow(), float: float(), centering: centered(), caption: caption().trim(), captionPos: captionPos(), label: label().trim(),
  });
  if (figureStartPath && !label()) setLabel(slugLabel(baseName(figureStartPath)));
  const [tpl, setTpl] = createSignal(general.figureTemplate || '');
  const [edited, setEdited] = createSignal(null);
  const tplText = () => (templates('figures').find((x) => x.name === tpl()) || {}).text;
  // A template holds ONE image; subfigures use the assistant's own layout.
  const usingTpl = () => !!(tpl() && tplText() != null && !many());
  const parts = () => figureParts(options());
  const code = createMemo(() => (usingTpl() ? fillTemplate(tplText(), parts()) : figureLatex(options())));
  const insert = () => { insertSnippet((edited() ?? code()) + '\n'); setFigureOpen(false); };
  const templateText = () => {
    if (edited() != null) return templatize(edited(), parts());
    const p = { ...parts(), caption: parts().caption || SENT_CAP, label: parts().label || SENT_LAB };
    return templatize(usingTpl() ? fillTemplate(tplText(), p) : figureLatex({ ...options(), caption: p.caption, label: p.label }), p);
  };

  return (
    <div class="cfg-overlay">
      <div class="cfg-modal wz-modal wz-wide" style={pos() ? { left: pos().x + 'px', top: pos().y + 'px', transform: 'none' } : undefined}>
        <div class="cfg-titlebar" onPointerDown={startDrag}>
          <span>{tr('Asistente de figura', 'Figure assistant')}</span>
          <button class="cfg-close" title={tr('Cerrar', 'Close')} onClick={() => setFigureOpen(false)}>✕</button>
        </div>
        <div class="wz-body">
          <TemplateBar kind="figures" selected={tpl} setSelected={setTpl} templateText={templateText} discard={() => setEdited(null)} />
          <div class="wz-images">
            <Index each={images()}>
              {(im, i) => (
                <div class="wz-image">
                  <Thumb path={im().path} root={root()} />
                  <div class="wz-image-fields">
                    <div class="wz-row">
                      <input type="text" value={im().path} spellcheck={false} onInput={(e) => setImage(i, { path: e.target.value })}
                        placeholder={tr('ruta/imagen.png (relativa a la carpeta del documento raíz)', 'path/image.png (relative to the main document\\\'s folder)')} />
                      <button class="wz-browse" onClick={() => browse(i)}>{tr('Examinar…', 'Browse…')}</button>
                      <Show when={images().length > 1}>
                        <button class="wz-browse" title={tr('Quitar esta imagen', 'Remove this image')} onClick={() => setImages(images().filter((_, k) => k !== i))}>✕</button>
                      </Show>
                    </div>
                    <Show when={many()}>
                      <div class="wz-row">
                        <input type="text" value={im().caption} onInput={(e) => setImage(i, { caption: e.target.value })}
                          placeholder={tr(`Título de la subfigura (${String.fromCharCode(97 + i)})`, `Subfigure caption (${String.fromCharCode(97 + i)})`)} />
                      </div>
                    </Show>
                  </div>
                </div>
              )}
            </Index>
            <button class="wz-browse wz-add" disabled={images().length >= 8}
              title={tr('Varias imágenes se colocan una junto a otra, cada una con su título: (a), (b)…', 'Several images go side by side, each with its caption: (a), (b)…')}
              onClick={() => setImages([...images(), { path: '', caption: '' }])}>{tr('+ Añadir otra imagen (subfiguras)', '+ Add another image (subfigures)')}</button>
          </div>
          <div class="wz-cols">
            <div class="wz-col">
              <Show when={!many()} fallback={
                <Field label={tr('Por fila', 'Per row')}><input type="number" min="1" max="4" value={perRow()} onChange={(e) => setPerRow(Math.max(1, Math.min(4, +e.target.value || 1)))} />
                  <span class="wz-hint">{tr('imágenes en cada fila', 'images per row')}</span></Field>
              }>
                <Field label={tr('Ancho', 'Width')}>
                  <select class="wz-short" value={unit()} onChange={(e) => setUnit(e.target.value)}>
                    <option value="textwidth">{tr('% del texto', '% of text')}</option>
                    <option value="cm">cm</option>
                    <option value="natural">{tr('original', 'original')}</option>
                  </select>
                  <Show when={unit() === 'textwidth'}>
                    <input type="range" min="0.1" max="1" step="0.05" value={width()} onInput={(e) => setWidth(+e.target.value)} />
                    <span class="wz-val">{Math.round(width() * 100)} %</span>
                  </Show>
                  <Show when={unit() === 'cm'}>
                    <input type="number" min="0.5" max="40" step="0.1" value={widthCm()} onChange={(e) => setWidthCm(+e.target.value || 10)} />
                    <span class="wz-hint">cm</span>
                  </Show>
                </Field>
              </Show>
              <Field label={tr('Alto máximo', 'Max height')} title={tr('0 = sin límite. Con ancho y alto a la vez la imagen conserva su proporción (keepaspectratio).', '0 = no limit. With both width and height the image keeps its proportions (keepaspectratio).')}>
                <input type="number" min="0" max="40" step="0.5" value={height()} onChange={(e) => setHeight(Math.max(0, +e.target.value || 0))} />
                <span class="wz-hint">{tr('cm (0 = sin límite)', 'cm (0 = no limit)')}</span>
              </Field>
              <Field label={tr('Rotación', 'Rotation')}>
                <input type="number" min="-180" max="180" step="90" value={angle()} onChange={(e) => setAngle(+e.target.value || 0)} />
                <span class="wz-hint">{tr('grados', 'degrees')}</span>
              </Field>
              <Field label={tr('Centrada', 'Centred')}><input type="checkbox" checked={centered()} onChange={(e) => setCentered(e.target.checked)} /></Field>
            </div>
            <div class="wz-col">
              <Field label={tr('Colocación', 'Placement')}>
                <select value={float()} onChange={(e) => setFloat(e.target.value)}>
                  <For each={FLOATS()}>{(f) => <option value={f[0]}>{f[1]}</option>}</For>
                  <option value="none">{tr('Solo la imagen (sin entorno figure)', 'Only the image (no figure environment)')}</option>
                </select>
              </Field>
              <Field label={tr('Pie de figura', 'Caption')}>
                <input type="text" value={caption()} disabled={float() === 'none'} onInput={(e) => setCaption(e.target.value)} placeholder={tr('Descripción de la figura', 'Description of the figure')} />
                <select class="wz-short" value={captionPos()} disabled={float() === 'none'} onChange={(e) => setCaptionPos(e.target.value)}>
                  <option value="bottom">{tr('abajo', 'below')}</option>
                  <option value="top">{tr('arriba', 'above')}</option>
                </select>
              </Field>
              <Field label={tr('Etiqueta', 'Label')}>
                <input type="text" value={label()} disabled={float() === 'none'} onInput={(e) => setLabel(e.target.value)} placeholder={tr('mi-figura → \\ref{fig:mi-figura}', 'my-figure → \\ref{fig:my-figure}')} />
              </Field>
            </div>
          </div>
          <CodeBox kind="figures" code={code} edited={edited} setEdited={setEdited} />
          <Show when={!usingTpl()}><Needs list={figurePackages(options())} /></Show>
          <Show when={!usingTpl()}><StyleButtons key="figureStyle" get={styleNow} reset={resetStyle} /></Show>
        </div>
        <div class="cfg-footer">
          <button onClick={() => setFigureOpen(false)}>{tr('Cancelar', 'Cancel')}</button>
          <button class="primary" onClick={insert}>{tr('Insertar figura', 'Insert figure')}</button>
        </div>
      </div>
    </div>
  );
}

export default function Wizards() {
  return (
    <>
      <Show when={tableOpen()}><TableWizard /></Show>
      <Show when={figureOpen()}><FigureWizard /></Show>
    </>
  );
}
