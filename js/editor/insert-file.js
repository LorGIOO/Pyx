// A file placed in the document: dropped on the editor, or chosen with
// «Insertar archivo» (the paper clip). Each kind of file has its call:
//
//   Excel (.xlsx/.xlsm)  \hoja[Sheet]{path}            (then \celda{E4}…)
//   CSV                  \hoja{path}
//   Jupyter (.ipynb)     \pynotebook{path}
//   Python (.py)         \pyfile{path} (or its listing)
//   PDF                  \includepdf[pages=…]{path}  (or a figure of one page)
//   image                a figure — the figure template marked as default
//   .tex / .pltx         \input{path}
//   .bib                 \bibliography{path}
//
// What is written comes from the file templates (templates/files/<kind>.tex,
// stores/templatesStore.js), so a person can change it once for good. Paths
// are relative to the folder of the MAIN document, as LaTeX reads them.
import { relativePath, baseName, stemOf } from '../core/paths.js';
import { activeRootDir } from '../compile/compiler.js';
import { sheetNames } from '../core/platform.js';
import { fillTemplate, fileTemplate, loadTemplates, templates } from '../solid/stores/templatesStore.js';
import { figureLatex, figureParts, slugLabel } from './table-gen.js';
import { general } from '../solid/stores/settingsStore.js';

const EXT_KIND = {
  xlsx: 'excel', xlsm: 'excel', csv: 'csv', tsv: 'csv',
  ipynb: 'notebook', py: 'python', pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image', svg: 'image', eps: 'image', webp: 'image',
  tex: 'tex', pltx: 'tex', bib: 'bib',
};

export function kindOf(path) {
  const ext = String(path || '').split('.').pop().toLowerCase();
  return EXT_KIND[ext] || null;
}

/** The path as the main document names it (forward slashes, `..` if needed). */
export async function docRelative(path) {
  const root = await activeRootDir().catch(() => undefined);
  return relativePath(root || '', String(path));
}

/** The values a file template is filled with. */
export function fileVars(rel, extra = {}) {
  const noext = rel.replace(/\.[^./\\]+$/, '');
  return {
    path: rel,
    path_noext: noext,
    name: baseName(rel),
    sheet: '',
    pages: '-',
    page: '1',
    width: '0.8\\textwidth',
    caption: '',
    label: slugLabel(stemOf(rel) || 'archivo'),
    ...extra,
  };
}

/** A figure for an image, with the figure template marked as default (or
 *  the assistant's own options when there is none). */
export async function imageCall(rel, extra = {}) {
  const name = general.figureTemplate || '';
  let list = templates('figures');
  if (name && !list.length) list = await loadTemplates('figures');
  const tpl = name && list.find((x) => x.name === name);
  const st = general.figureStyle && typeof general.figureStyle === 'object' ? general.figureStyle : {};
  const o = {
    images: [{ path: rel, caption: '' }],
    unit: st.unit || 'textwidth', width: st.unit === 'cm' ? (st.widthCm || 10) : (st.width || 0.8), height: st.height || 0,
    float: st.float || 'htbp', centering: st.centered !== false, captionPos: st.captionPos || 'bottom',
    caption: extra.caption || '', label: extra.label ?? slugLabel(stemOf(rel) || 'figura'),
  };
  return tpl ? fillTemplate(tpl.text, figureParts(o)) : figureLatex(o);
}

/** The call for a file, with the default choices (what a drop writes). */
export async function defaultCall(path) {
  const kind = kindOf(path);
  if (!kind) return null;
  const rel = await docRelative(path);
  if (kind === 'image') return imageCall(rel);
  const extra = {};
  if (kind === 'excel') {
    try { extra.sheet = (await sheetNames(String(path)))[0] || ''; } catch (_) { /* no sheet: \hoja{…} alone */ }
  }
  return fillTemplate(await fileTemplate(kind), fileVars(rel, extra));
}
