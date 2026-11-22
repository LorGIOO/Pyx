import { createSignal, createMemo, createEffect, Show, For } from 'solid-js';
import { t as tr } from '../../core/i18n.js';
import { insertSnippet } from '../../editor/commands.js';
import { openInsertableDialog, sheetNames, revealInExplorer } from '../../core/platform.js';
import { baseName } from '../../core/paths.js';
import { registerDialog, closeDialogs } from '../stores/dialogStore.js';
import { kindOf, docRelative, fileVars, imageCall } from '../../editor/insert-file.js';
import { loadTemplates, fileVariants, fillTemplate, fileTemplate } from '../stores/templatesStore.js';
import { userDir } from '../../core/userfiles.js';
import { openFigureWizard } from './Wizards.jsx';

// «Insertar archivo» (the paper clip in Inicio → Insertar): choose a file and
// answer what that kind of file needs — the sheet of a workbook, the pages of
// a PDF, whether a .py runs or is shown — then insert the call. The code is
// shown, editable, before it goes in; the calls come from the file templates
// (templates/files/*.tex), which «Carpeta» opens.

const [open, setOpen] = createSignal(false);
const [path, setPath] = createSignal('');
registerDialog(open, () => setOpen(false));

/** Open the dialog, with a file already chosen or not. */
export async function openInsertFile(p = '') {
  closeDialogs();
  await loadTemplates('files');
  setPath(p || '');
  setOpen(true);
  if (!p) pickFile();
}

async function pickFile() {
  const p = await openInsertableDialog();
  if (typeof p === 'string' && p) setPath(p);
  else if (!path()) setOpen(false);
}

const KIND_LABEL = () => ({
  excel: tr('Libro de Excel', 'Excel workbook'),
  csv: tr('Tabla CSV', 'CSV table'),
  notebook: tr('Cuaderno de Jupyter', 'Jupyter notebook'),
  python: tr('Script de Python', 'Python script'),
  pdf: 'PDF',
  image: tr('Imagen', 'Image'),
  tex: tr('Documento LaTeX', 'LaTeX document'),
  bib: tr('Bibliografía', 'Bibliography'),
});

function Dialog() {
  const kind = () => kindOf(path());
  const [rel, setRel] = createSignal('');
  const [sheets, setSheets] = createSignal([]);
  const [sheet, setSheet] = createSignal('');
  const [cell, setCell] = createSignal('');
  const [pdfMode, setPdfMode] = createSignal('pages'); // 'pages' | 'figure'
  const [pages, setPages] = createSignal('-');
  const [page, setPage] = createSignal('1');
  const [width, setWidth] = createSignal('0.8\\textwidth');
  const [caption, setCaption] = createSignal('');
  const [variant, setVariant] = createSignal(''); // a file template name
  const [texCmd, setTexCmd] = createSignal('input');
  const [edited, setEdited] = createSignal(null);
  const [code, setCode] = createSignal('');

  // A new file: its path relative to the main document, its sheets.
  createEffect(() => {
    const p = path();
    setEdited(null);
    setRel('');
    setSheets([]);
    setSheet('');
    setVariant(kindOf(p) === 'pdf' ? '' : kindOf(p) || '');
    if (!p) return;
    docRelative(p).then(setRel);
    if (kindOf(p) === 'excel') {
      sheetNames(p).then((names) => { setSheets(names || []); setSheet((names || [])[0] || ''); }).catch(() => setSheets([]));
    }
  });

  const variants = createMemo(() => (kind() && kind() !== 'image' ? fileVariants(kind() === 'pdf' && pdfMode() === 'figure' ? 'pdf-figure' : kind()) : []));

  // The code, recomputed from the answers (until edited by hand).
  createEffect(async () => {
    const k = kind();
    const r = rel();
    if (!k || !r) { setCode(''); return; }
    if (k === 'image') { setCode(await imageCall(r, { caption: caption() })); return; }
    if (k === 'tex' && !variant().includes(' - ')) {
      const noext = r.replace(/\.(tex|pltx)$/i, '');
      setCode(texCmd() === 'subfile' ? `\\subfile{${r}}` : `\\${texCmd()}{${noext}}`);
      return;
    }
    const tplName = k === 'pdf' ? (variant() || (pdfMode() === 'figure' ? 'pdf-figure' : 'pdf')) : (variant() || k);
    const tpl = await fileTemplate(tplName);
    let out = fillTemplate(tpl, fileVars(r, {
      sheet: sheet(), pages: pages().trim() || '-', page: page().trim() || '1', width: width().trim() || '\\linewidth', caption: caption(),
    }));
    if ((k === 'excel' || k === 'csv') && cell().trim()) out += `\n\\celda{${cell().trim()}}`;
    setCode(out);
  });

  const insert = () => {
    const text = edited() ?? code();
    if (!text) return;
    insertSnippet(text.endsWith('\n') ? text : text + '\n');
    setOpen(false);
  };
  const folder = async () => {
    const d = await userDir();
    const sep = d.includes('\\') ? '\\' : '/';
    if (d) revealInExplorer(`${d}${sep}templates${sep}files`);
  };

  return (
    <div class="cfg-overlay">
      <div class="cfg-modal wz-modal insfile-modal">
        <div class="cfg-titlebar">
          <span>{tr('Insertar archivo', 'Insert file')}</span>
          <button class="cfg-close" title={tr('Cerrar', 'Close')} onClick={() => setOpen(false)}>✕</button>
        </div>
        <div class="wz-body">
          <div class="wz-row">
            <span class="wz-label">{tr('Archivo', 'File')}</span>
            <input type="text" readOnly value={rel() || baseName(path())} title={path()} />
            <button class="wz-browse" onClick={pickFile}>{tr('Elegir…', 'Choose…')}</button>
          </div>
          <Show when={path() && !kind()}>
            <p class="wz-hint">{tr('Pyx no sabe cómo llamar a este tipo de archivo. Puedes escribir la llamada a mano en el documento.', 'Pyx does not know how to call this kind of file. You can write the call by hand in the document.')}</p>
          </Show>
          <Show when={kind()}>
            <div class="wz-row">
              <span class="wz-label">{tr('Tipo', 'Kind')}</span>
              <span class="insfile-kind">{KIND_LABEL()[kind()]}</span>
            </div>

            <Show when={kind() === 'excel'}>
              <div class="wz-row">
                <span class="wz-label">{tr('Hoja', 'Sheet')}</span>
                <Show when={sheets().length} fallback={<input type="text" value={sheet()} onInput={(e) => setSheet(e.target.value)} placeholder={tr('nombre de la hoja (vacío: la primera)', 'sheet name (empty: the first)')} />}>
                  <select value={sheet()} onChange={(e) => setSheet(e.target.value)}>
                    <For each={sheets()}>{(s) => <option value={s}>{s}</option>}</For>
                  </select>
                </Show>
              </div>
            </Show>
            <Show when={kind() === 'excel' || kind() === 'csv'}>
              <div class="wz-row">
                <span class="wz-label">{tr('Celda o rango', 'Cell or range')}</span>
                <input type="text" value={cell()} onInput={(e) => setCell(e.target.value)} spellcheck={false}
                  placeholder={tr('opcional: E4, E4:F8, un nombre definido…', 'optional: E4, E4:F8, a defined name…')} />
              </div>
              <p class="wz-hint">{tr('Después, \\celda{E4} coloca el valor de una celda en cualquier parte del documento; \\celda[.2f]{E4} con 2 decimales.', 'Then \\celda{E4} places a cell\'s value anywhere in the document; \\celda[.2f]{E4} with 2 decimals.')}</p>
            </Show>

            <Show when={kind() === 'pdf'}>
              <div class="wz-row">
                <span class="wz-label">{tr('Cómo', 'How')}</span>
                <select value={pdfMode()} onChange={(e) => { setPdfMode(e.target.value); setVariant(''); }}>
                  <option value="pages">{tr('Sus páginas tal cual (\\includepdf)', 'Its pages as they are (\\includepdf)')}</option>
                  <option value="figure">{tr('Una página como figura', 'One page as a figure')}</option>
                </select>
              </div>
              <Show when={pdfMode() === 'pages'} fallback={
                <>
                  <div class="wz-row">
                    <span class="wz-label">{tr('Página', 'Page')}</span>
                    <input type="number" min="1" value={page()} onInput={(e) => setPage(e.target.value)} />
                  </div>
                  <div class="wz-row">
                    <span class="wz-label">{tr('Ancho', 'Width')}</span>
                    <input type="text" value={width()} onInput={(e) => setWidth(e.target.value)} spellcheck={false} />
                  </div>
                </>
              }>
                <div class="wz-row">
                  <span class="wz-label">{tr('Páginas', 'Pages')}</span>
                  <input type="text" value={pages()} onInput={(e) => setPages(e.target.value)} spellcheck={false}
                    placeholder={tr('- (todas), 1-3, 2,5,7…', '- (all), 1-3, 2,5,7…')} />
                </div>
              </Show>
            </Show>

            <Show when={kind() === 'tex'}>
              <div class="wz-row">
                <span class="wz-label">{tr('Comando', 'Command')}</span>
                <select value={texCmd()} onChange={(e) => setTexCmd(e.target.value)}>
                  <option value="input">{tr('\\input — el texto entra donde está', '\\input — the text goes in right here')}</option>
                  <option value="include">{tr('\\include — empieza en página nueva', '\\include — starts on a new page')}</option>
                  <option value="subfile">{tr('\\subfile — un documento que también compila solo', '\\subfile — a document that also compiles on its own')}</option>
                </select>
              </div>
            </Show>

            <Show when={kind() === 'image' || (kind() === 'pdf' && pdfMode() === 'figure')}>
              <div class="wz-row">
                <span class="wz-label">{tr('Pie de figura', 'Caption')}</span>
                <input type="text" value={caption()} onInput={(e) => setCaption(e.target.value)} />
              </div>
            </Show>
            <Show when={kind() === 'image'}>
              <p class="wz-hint">{tr('Se usa la plantilla de figura marcada como predeterminada. Para elegir otra, ancho, subfiguras…:', 'The figure template marked as default is used. To choose another, the width, subfigures…:')}{' '}
                <button class="wz-link" onClick={() => { const p = rel(); setOpen(false); openFigureWizard(p); }}>{tr('abrir el asistente de figura', 'open the figure assistant')}</button></p>
            </Show>

            <Show when={variants().length > 1}>
              <div class="wz-row">
                <span class="wz-label">{tr('Plantilla', 'Template')}</span>
                <select value={variant()} onChange={(e) => setVariant(e.target.value)}>
                  <For each={variants()}>{(v) => <option value={v.name}>{v.name}</option>}</For>
                </select>
              </div>
            </Show>

            <textarea class="wz-code" spellcheck={false} rows={6} value={edited() ?? code()} onInput={(e) => setEdited(e.target.value)} />
            <div class="wz-codebar">
              <Show when={edited() != null} fallback={<span class="wz-hint">{tr('Puedes editar la llamada antes de insertarla. Lo que Pyx escribe para cada tipo está en las plantillas de archivos.', 'You can edit the call before inserting it. What Pyx writes for each kind is in the file templates.')}</span>}>
                <button class="wz-browse" onClick={() => setEdited(null)}>{tr('Descartar cambios', 'Discard changes')}</button>
              </Show>
              <span class="wz-grow" />
              <button class="wz-browse" onClick={folder}>{tr('Plantillas de archivos…', 'File templates…')}</button>
            </div>
          </Show>
        </div>
        <div class="cfg-footer">
          <button onClick={() => setOpen(false)}>{tr('Cancelar', 'Cancel')}</button>
          <button class="primary" disabled={!(edited() ?? code())} onClick={insert}>{tr('Insertar', 'Insert')}</button>
        </div>
      </div>
    </div>
  );
}

export default function InsertFileDialog() {
  return <Show when={open()}><Dialog /></Show>;
}
