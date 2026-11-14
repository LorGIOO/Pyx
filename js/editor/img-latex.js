// A picture on the clipboard, pasted into the document: it is saved into the
// project's image folder and its figure is written at the caret.

import { messageDialog, writeBinaryFile, createDir } from '../core/platform.js';
import { joinPath, relativePath } from '../core/paths.js';
import { general } from '../solid/stores/settingsStore.js';
import { figureLatex } from './table-gen.js';

/* ---------- the picture itself, as a figure ---------- */

const stampName = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `captura-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Save `bytes` into the project's image folder and insert the figure. */
export async function insertImageAsFigure(view, bytes, ext = 'png') {
  if (!view || !bytes || !bytes.length) return false;
  const { activeRootDir } = await import('../compile/compiler.js');
  const root = await activeRootDir();
  if (!root) {
    messageDialog('Guarda el documento antes de pegar una imagen: se guarda en una carpeta junto a él.', { title: 'Pegar imagen' });
    return false;
  }
  // Configuración → Editor → «Carpeta de las imágenes pegadas», relative to
  // the root document's folder (LaTeX resolves \includegraphics from there).
  const folder = String(general.pasteImageDir || 'imagenes').replace(/^[\\/]+|[\\/]+$/g, '') || 'imagenes';
  const dir = joinPath(root, folder);
  const file = joinPath(dir, `${stampName()}.${ext}`);
  try {
    await createDir(dir).catch(() => {}); // already there
    await writeBinaryFile(file, bytes);
  } catch (e) {
    messageDialog(`No se pudo guardar la imagen en ${dir}.\n\n${String((e && e.message) || e)}`, { title: 'Pegar imagen', kind: 'error' });
    return false;
  }
  const HOLE = '\u0000';
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.from);
  const lead = view.state.doc.sliceString(line.from, sel.from).trim() ? '\n' : '';
  let tex = lead + figureLatex({
    images: [{ path: relativePath(root, file) }], unit: 'textwidth', width: 0.8, float: 'htbp', caption: HOLE,
  }) + '\n';
  // The caret waits inside \caption{}: the title is the one thing missing.
  const at = tex.indexOf(HOLE);
  tex = tex.replace(HOLE, '');
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: tex },
    selection: { anchor: sel.from + at },
    userEvent: 'input.paste',
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** A picture was pasted into the editor (no text with it). */
export async function pastedImage(view, blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return insertImageAsFigure(view, bytes, /jpe?g/i.test(blob.type) ? 'jpg' : 'png');
}
