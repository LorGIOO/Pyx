// Files dragged from the system's file explorer onto Pyx.
//
// On the editor: each file's CALL goes in where it was dropped — \hoja[…]{…}
// for a workbook, \pynotebook{…}, a figure with the default figure template
// for an image, \includepdf for a PDF… (editor/insert-file.js). With Shift
// held, the «Insertar archivo» dialog opens instead, to answer its options.
// Anywhere else, a .pltx / .tex opens as a document, as before.
//
// The desktop webview takes the drop (it is the only one that knows the real
// paths), so this listens to Tauri's drag-drop event, not to HTML5's.
import { isTauri } from '../core/platform.js';
import { activeDoc } from '../core/state.js';
import { getViewOfDoc } from './setup.js';
import { insertSnippet } from './commands.js';
import { defaultCall, kindOf } from './insert-file.js';

let shift = false;
const track = (e) => { shift = e.shiftKey; };

export async function installFileDrop({ openPath }) {
  if (!isTauri()) return;
  addEventListener('keydown', track, true);
  addEventListener('keyup', track, true);
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  await getCurrentWebview().onDragDropEvent(async (event) => {
    const p = event.payload || {};
    document.body.classList.toggle('pyx-file-over', p.type === 'over' || p.type === 'enter');
    if (p.type !== 'drop' || !Array.isArray(p.paths) || !p.paths.length) return;
    document.body.classList.remove('pyx-file-over');
    const dpr = window.devicePixelRatio || 1;
    const x = (p.position && p.position.x) / dpr;
    const y = (p.position && p.position.y) / dpr;
    const el = Number.isFinite(x) ? document.elementFromPoint(x, y) : null;
    const host = el && el.closest('.editor-host');
    const doc = activeDoc();
    const onEditor = !!(host && doc && !doc.kind);

    if (!onEditor) {
      // Not on the text: documents open, other files go to the active editor.
      for (const path of p.paths) {
        if (/\.(pltx|tex|sty|cls|bib|txt)$/i.test(path)) await openPath(path);
      }
      return;
    }
    // Where the drop landed, in the text.
    const view = getViewOfDoc(doc.id);
    if (view) {
      const pos = view.posAtCoords({ x, y });
      if (pos != null) {
        const line = view.state.doc.lineAt(pos);
        // A block call goes on a line of its own: at the start of the line
        // under the pointer when that line is blank, else after it.
        const at = line.text.trim() ? line.to : line.from;
        view.dispatch({ selection: { anchor: at } });
        view.focus();
      }
    }
    if (shift && p.paths.length === 1) {
      const { openInsertFile } = await import('../solid/components/InsertFileDialog.jsx');
      openInsertFile(p.paths[0]);
      return;
    }
    const calls = [];
    for (const path of p.paths) {
      if (!kindOf(path)) continue;
      const c = await defaultCall(path).catch(() => null);
      if (c) calls.push(c);
    }
    if (!calls.length) return;
    const v = view && view.state;
    const atLineStart = v && v.selection.main.head === v.doc.lineAt(v.selection.main.head).from;
    insertSnippet((atLineStart ? '' : '\n') + calls.join('\n') + '\n');
  });
}
