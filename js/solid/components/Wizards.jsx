import { createSignal, createMemo, createEffect, onCleanup, Show, For, Index } from 'solid-js';
import { insertSnippet } from '../../editor/commands.js';
import { openImageDialog, readBinaryFile } from '../../core/platform.js';
import { relativePath, joinPath, baseName } from '../../core/paths.js';
import { activeRootDir } from '../../compile/compiler.js';
import { parseTsv, parseHtmlTable, tableRules } from '../../editor/paste-table.js';
import {
  tableLatex, tablePackages, figureLatex, figurePackages, slugLabel,
} from '../../editor/table-gen.js';
import { getDocContent } from '../../editor/setup.js';
import { activeDoc } from '../../core/state.js';
import { registerDialog, closeDialogs } from '../stores/dialogStore.js';

// Table & figure assistants: movable dialogs (the Configuración chrome) where
// the table is FILLED IN — typed, or pasted from a spreadsheet — and the
// figure is seen before it is inserted. Both show the LaTeX they will write
// (editor/table-gen.js), so there is no guessing what "Insertar" does.

const [tableOpen, setTableOpen] = createSignal(false);
const [figureOpen, setFigureOpen] = createSignal(false);
// Opening one closes any other dialog, and Escape closes it (dialogStore).
export const openTableWizard = () => { closeDialogs(); setTableOpen(true); };
export const openFigureWizard = () => { closeDialogs(); setFigureOpen(true); };
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

const FLOATS = [
  ['htbp', 'Donde mejor quepa [htbp]'],
  ['H', 'Exactamente aquí [H]'],
  ['t', 'Arriba de la página [t]'],
  ['b', 'Abajo de la página [b]'],
  ['p', 'En página aparte [p]'],
];

/** The note under the code: what the document must load for it to compile. */
const Needs = (props) => (
  <Show when={props.list.length}>
    <div class="wz-needs">
      Requiere en el preámbulo: {props.list.map((p) => `\\usepackage{${p}}`).join('  ')}
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
    ['Columna 1', 'Columna 2', 'Columna 3'],
    ['', '', ''],
    ['', '', ''],
  ]);
  const [align, setAlign] = createSignal(['l', 'l', 'l']);
  const [rules, setRules] = createSignal(tableRules(activeDoc() ? getDocContent(activeDoc().id) : ''));
  const [vlines, setVlines] = createSignal(false);
  const [header, setHeader] = createSignal(true);
  const [headerBold, setHeaderBold] = createSignal(true);
  const [escape, setEscape] = createSignal(true);
  const [float, setFloat] = createSignal('htbp');
  const [caption, setCaption] = createSignal('');
  const [captionPos, setCaptionPos] = createSignal('top');
  const [label, setLabel] = createSignal('');
  const [size, setSize] = createSignal('');
  const [fit, setFit] = createSignal(false);
  const [pWidth, setPWidth] = createSignal('3cm');
  let gridEl;

  const nRows = () => cells().length;
  const nCols = () => cells()[0].length;
  const resize = (r, c) => {
    r = Math.max(1, Math.min(MAX_ROWS, r | 0));
    c = Math.max(1, Math.min(MAX_COLS, c | 0));
    setCells(Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => (cells()[i] && cells()[i][j]) || '')));
    setAlign(Array.from({ length: c }, (_, j) => align()[j] || 'l'));
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
  const code = createMemo(() => tableLatex(options()));
  const insert = () => { insertSnippet(code() + '\n'); setTableOpen(false); };

  return (
    <div class="cfg-overlay">
      <div class="cfg-modal wz-modal wz-wide" style={pos() ? { left: pos().x + 'px', top: pos().y + 'px', transform: 'none' } : undefined}>
        <div class="cfg-titlebar" onPointerDown={startDrag}>
          <span>Asistente de tabla</span>
          <button class="cfg-close" onClick={() => setTableOpen(false)}>✕</button>
        </div>
        <div class="wz-body">
          <div class="wz-toolbar">
            <Field label="Filas"><input type="number" min="1" max={MAX_ROWS} value={nRows()} onChange={(e) => resize(+e.target.value, nCols())} /></Field>
            <Field label="Columnas"><input type="number" min="1" max={MAX_COLS} value={nCols()} onChange={(e) => resize(nRows(), +e.target.value)} /></Field>
            <span class="wz-hint wz-grow">Escribe en las celdas o <b>pega aquí las celdas copiadas de Excel</b>: la tabla se rellena y crece sola. Intro baja de fila.</span>
          </div>
          <div class="wz-grid-wrap">
            <table class="wz-grid" ref={gridEl}>
              <thead>
                <tr>
                  <Index each={align()}>
                    {(a, j) => (
                      <th>
                        <select value={a()} title="Alineación de la columna" onChange={(e) => setColAlign(j, e.target.value)}>
                          <option value="l">⇤ izq.</option>
                          <option value="c">↔ centro</option>
                          <option value="r">⇥ der.</option>
                          <option value="p">¶ párrafo</option>
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
              <Field label="Líneas">
                <select value={rules()} onChange={(e) => setRules(e.target.value)}>
                  <option value="booktabs">booktabs (profesional)</option>
                  <option value="hline">\hline arriba, bajo la cabecera y abajo</option>
                  <option value="grid">Cuadrícula completa</option>
                  <option value="none">Sin líneas</option>
                </select>
              </Field>
              <Field label="Cabecera">
                <input type="checkbox" checked={header()} onChange={(e) => setHeader(e.target.checked)} />
                <span class="wz-hint">la primera fila</span>
                <input type="checkbox" checked={headerBold()} disabled={!header()} onChange={(e) => setHeaderBold(e.target.checked)} />
                <span class="wz-hint">en negrita</span>
              </Field>
              <Field label="Líneas verticales" title="No se recomiendan con booktabs">
                <input type="checkbox" checked={vlines()} onChange={(e) => setVlines(e.target.checked)} />
              </Field>
              <Field label="Celdas de texto" title="Escapa % & _ # $ { } en las celdas. Desactívalo si escribes LaTeX en ellas ($x^2$, \textbf{…}).">
                <input type="checkbox" checked={escape()} onChange={(e) => setEscape(e.target.checked)} />
                <span class="wz-hint">escapar % &amp; _ $ … (quítalo si escribes LaTeX)</span>
              </Field>
              <Show when={align().includes('p')}>
                <Field label="Ancho de ¶"><input type="text" value={pWidth()} onInput={(e) => setPWidth(e.target.value)} placeholder="3cm" /></Field>
              </Show>
            </div>
            <div class="wz-col">
              <Field label="Colocación">
                <select value={float()} onChange={(e) => setFloat(e.target.value)}>
                  <For each={FLOATS}>{(f) => <option value={f[0]}>{f[1]}</option>}</For>
                  <option value="none">Solo el tabular (sin entorno table)</option>
                </select>
              </Field>
              <Field label="Título">
                <input type="text" value={caption()} disabled={float() === 'none'} onInput={(e) => setCaption(e.target.value)} placeholder="Descripción de la tabla" />
                <select class="wz-short" value={captionPos()} disabled={float() === 'none'} onChange={(e) => setCaptionPos(e.target.value)}>
                  <option value="top">arriba</option>
                  <option value="bottom">abajo</option>
                </select>
              </Field>
              <Field label="Etiqueta">
                <input type="text" value={label()} disabled={float() === 'none'} onInput={(e) => setLabel(e.target.value)} placeholder="mi-tabla → \ref{tab:mi-tabla}" />
                <button class="wz-browse" disabled={float() === 'none' || !caption().trim()} title="Proponer una etiqueta a partir del título"
                  onClick={(e) => { e.preventDefault(); setLabel(slugLabel(caption())); }}>Del título</button>
              </Field>
              <Field label="Tamaño de letra">
                <select value={size()} onChange={(e) => setSize(e.target.value)}>
                  <option value="">Normal</option>
                  <option value="small">Pequeña (\small)</option>
                  <option value="footnotesize">Más pequeña (\footnotesize)</option>
                  <option value="scriptsize">Mínima (\scriptsize)</option>
                </select>
              </Field>
              <Field label="Si no cabe" title="Reduce la tabla al ancho del texto solo cuando es más ancha">
                <input type="checkbox" checked={fit()} onChange={(e) => setFit(e.target.checked)} />
                <span class="wz-hint">reducirla al ancho del texto</span>
              </Field>
            </div>
          </div>
          <pre class="wz-code">{code()}</pre>
          <Needs list={tablePackages(options())} />
        </div>
        <div class="cfg-footer">
          <button onClick={() => setTableOpen(false)}>Cancelar</button>
          <button class="primary" onClick={insert}>Insertar tabla</button>
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
  const [images, setImages] = createSignal([{ path: '', caption: '' }]);
  const [unit, setUnit] = createSignal('textwidth');
  const [width, setWidth] = createSignal(0.8);
  const [widthCm, setWidthCm] = createSignal(10);
  const [height, setHeight] = createSignal(0);
  const [angle, setAngle] = createSignal(0);
  const [perRow, setPerRow] = createSignal(2);
  const [float, setFloat] = createSignal('htbp');
  const [centered, setCentered] = createSignal(true);
  const [caption, setCaption] = createSignal('');
  const [captionPos, setCaptionPos] = createSignal('bottom');
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
  const code = createMemo(() => figureLatex(options()));
  const insert = () => { insertSnippet(code() + '\n'); setFigureOpen(false); };

  return (
    <div class="cfg-overlay">
      <div class="cfg-modal wz-modal wz-wide" style={pos() ? { left: pos().x + 'px', top: pos().y + 'px', transform: 'none' } : undefined}>
        <div class="cfg-titlebar" onPointerDown={startDrag}>
          <span>Asistente de figura</span>
          <button class="cfg-close" onClick={() => setFigureOpen(false)}>✕</button>
        </div>
        <div class="wz-body">
          <div class="wz-images">
            <Index each={images()}>
              {(im, i) => (
                <div class="wz-image">
                  <Thumb path={im().path} root={root()} />
                  <div class="wz-image-fields">
                    <div class="wz-row">
                      <input type="text" value={im().path} spellcheck={false} onInput={(e) => setImage(i, { path: e.target.value })}
                        placeholder="ruta/imagen.png (relativa a la carpeta del documento raíz)" />
                      <button class="wz-browse" onClick={() => browse(i)}>Examinar…</button>
                      <Show when={images().length > 1}>
                        <button class="wz-browse" title="Quitar esta imagen" onClick={() => setImages(images().filter((_, k) => k !== i))}>✕</button>
                      </Show>
                    </div>
                    <Show when={many()}>
                      <div class="wz-row">
                        <input type="text" value={im().caption} onInput={(e) => setImage(i, { caption: e.target.value })}
                          placeholder={`Título de la subfigura (${String.fromCharCode(97 + i)})`} />
                      </div>
                    </Show>
                  </div>
                </div>
              )}
            </Index>
            <button class="wz-browse wz-add" disabled={images().length >= 8}
              title="Varias imágenes se colocan una junto a otra, cada una con su título: (a), (b)…"
              onClick={() => setImages([...images(), { path: '', caption: '' }])}>+ Añadir otra imagen (subfiguras)</button>
          </div>
          <div class="wz-cols">
            <div class="wz-col">
              <Show when={!many()} fallback={
                <Field label="Por fila"><input type="number" min="1" max="4" value={perRow()} onChange={(e) => setPerRow(Math.max(1, Math.min(4, +e.target.value || 1)))} />
                  <span class="wz-hint">imágenes en cada fila</span></Field>
              }>
                <Field label="Ancho">
                  <select class="wz-short" value={unit()} onChange={(e) => setUnit(e.target.value)}>
                    <option value="textwidth">% del texto</option>
                    <option value="cm">cm</option>
                    <option value="natural">original</option>
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
              <Field label="Alto máximo" title="0 = sin límite. Con ancho y alto a la vez la imagen conserva su proporción (keepaspectratio).">
                <input type="number" min="0" max="40" step="0.5" value={height()} onChange={(e) => setHeight(Math.max(0, +e.target.value || 0))} />
                <span class="wz-hint">cm (0 = sin límite)</span>
              </Field>
              <Field label="Rotación">
                <input type="number" min="-180" max="180" step="90" value={angle()} onChange={(e) => setAngle(+e.target.value || 0)} />
                <span class="wz-hint">grados</span>
              </Field>
              <Field label="Centrada"><input type="checkbox" checked={centered()} onChange={(e) => setCentered(e.target.checked)} /></Field>
            </div>
            <div class="wz-col">
              <Field label="Colocación">
                <select value={float()} onChange={(e) => setFloat(e.target.value)}>
                  <For each={FLOATS}>{(f) => <option value={f[0]}>{f[1]}</option>}</For>
                  <option value="none">Solo la imagen (sin entorno figure)</option>
                </select>
              </Field>
              <Field label="Pie de figura">
                <input type="text" value={caption()} disabled={float() === 'none'} onInput={(e) => setCaption(e.target.value)} placeholder="Descripción de la figura" />
                <select class="wz-short" value={captionPos()} disabled={float() === 'none'} onChange={(e) => setCaptionPos(e.target.value)}>
                  <option value="bottom">abajo</option>
                  <option value="top">arriba</option>
                </select>
              </Field>
              <Field label="Etiqueta">
                <input type="text" value={label()} disabled={float() === 'none'} onInput={(e) => setLabel(e.target.value)} placeholder="mi-figura → \ref{fig:mi-figura}" />
              </Field>
            </div>
          </div>
          <pre class="wz-code">{code()}</pre>
          <Needs list={figurePackages(options())} />
        </div>
        <div class="cfg-footer">
          <button onClick={() => setFigureOpen(false)}>Cancelar</button>
          <button class="primary" onClick={insert}>Insertar figura</button>
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
