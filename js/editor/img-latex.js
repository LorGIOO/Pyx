// A picture on the clipboard, pasted into the document.
//
// A screenshot of a formula (a book, a PDF, a web page) becomes its LaTeX,
// written where the caret is — no leaving the app for a converter. Or the
// picture itself is saved into the project and inserted as a figure.
//
// The recognizer runs in its OWN process and its own environment (Rust:
// image_to_latex, runtime.rs setup_ocr): it is never the kernel the document
// computes in, and nothing is installed in the user's Python. The first use
// offers to download it.

import { state } from '../core/state.js';
import {
  ocrReady, setupOcr, imageToLatex, onAppEvent, askDialog, choiceDialog, messageDialog,
  writeBinaryFile, createDir, openImageDialog, readBinaryFile, isTauri,
} from '../core/platform.js';
import { joinPath, relativePath } from '../core/paths.js';
import { general } from '../solid/stores/settingsStore.js';
import { figureLatex } from './table-gen.js';
import { inMath, formulaInsert } from './formula-place.js';

/* ---------- the recognizer ---------- */

let installing = null;
/** The recognizer, installed (asking first). False when the user says no or
 *  the install fails (the reason is shown). */
async function ensureOcr() {
  if (await ocrReady()) return true;
  if (installing) return installing;
  const ok = await askDialog(
    'Para convertir una imagen en LaTeX, Pyx necesita su reconocedor de fórmulas.\n\n'
    + 'Se descarga una sola vez (unos 200 MB con sus modelos) en la carpeta de Pyx: no instala nada en tu Python. '
    + 'Después funciona sin conexión.\n\n¿Descargarlo ahora?',
    { title: 'Imagen → LaTeX', kind: 'info' });
  if (!ok) return false;
  installing = (async () => {
    state.ocrBusy = 'Preparando el reconocedor de fórmulas…';
    const unlisten = await onAppEvent('setup:line', (line) => { state.ocrBusy = String(line).slice(0, 90); });
    try {
      await setupOcr();
      return true;
    } catch (e) {
      messageDialog(`No se pudo instalar el reconocedor de fórmulas.\n\n${String((e && e.message) || e)}`,
        { title: 'Imagen → LaTeX', kind: 'error' });
      return false;
    } finally {
      if (typeof unlisten === 'function') unlisten();
      state.ocrBusy = '';
      installing = null;
    }
  })();
  return installing;
}

/** Recognize `bytes` (PNG/JPEG) and write the formula at the caret of `view`. */
export async function insertFormulaFromImage(view, bytes) {
  if (!view || !bytes || !bytes.length) return false;
  if (!isTauri()) { messageDialog('La conversión de imagen a LaTeX requiere la aplicación de escritorio.'); return false; }
  if (!(await ensureOcr())) return false;
  state.ocrBusy = 'Reconociendo la fórmula… (la primera vez descarga sus modelos)';
  try {
    const latex = await imageToLatex(bytes);
    // The caret as it is NOW: the user may have gone on typing meanwhile.
    const sel = view.state.selection.main;
    const doc = view.state.doc;
    const line = doc.lineAt(sel.from);
    const text = formulaInsert(latex, {
      math: inMath(doc.sliceString(0, sel.from), sel.from),
      mode: general.ocrMode || 'display',
      lineStart: !doc.sliceString(line.from, sel.from).trim(),
    });
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
      userEvent: 'input.paste',
      scrollIntoView: true,
    });
    view.focus();
    return true;
  } catch (e) {
    messageDialog(`No se pudo convertir la imagen.\n\n${String((e && e.message) || e)}`,
      { title: 'Imagen → LaTeX', kind: 'error' });
    return false;
  } finally {
    state.ocrBusy = '';
  }
}

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

/* ---------- entry points ---------- */

/** A picture was pasted into the editor (no text with it): a formula to
 *  recognize, or a figure to insert? Configuración can fix the answer. */
export async function pastedImage(view, blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const ext = /jpe?g/i.test(blob.type) ? 'jpg' : 'png';
  let what = general.pasteImageAs || 'ask';
  if (what === 'ask') {
    const ans = await choiceDialog('Has pegado una imagen. ¿Qué quieres hacer con ella?',
      { title: 'Pegar imagen', kind: 'info', yes: 'Convertir en fórmula LaTeX', no: 'Insertar como figura' });
    if (ans === 'cancel') return false;
    what = ans === 'yes' ? 'formula' : 'figure';
  }
  return what === 'formula' ? insertFormulaFromImage(view, bytes) : insertImageAsFigure(view, bytes, ext);
}

/** "Imagen → LaTeX" (cinta Matemáticas): the picture on the clipboard, or —
 *  with none there — one chosen from disk. */
export async function formulaFromClipboard(view) {
  if (!view) return false;
  let bytes = null;
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => /^image\//.test(t));
      if (type) { bytes = new Uint8Array(await (await item.getType(type)).arrayBuffer()); break; }
    }
  } catch (_) { /* no permission, or nothing readable: fall through to a file */ }
  if (!bytes) {
    const p = await openImageDialog().catch(() => null);
    if (!p) return false;
    if (!/\.(png|jpe?g|bmp|webp|gif)$/i.test(String(p))) {
      messageDialog('Elige una imagen PNG o JPG con la fórmula (una captura de pantalla sirve).', { title: 'Imagen → LaTeX' });
      return false;
    }
    bytes = await readBinaryFile(String(p));
  }
  return insertFormulaFromImage(view, bytes);
}
