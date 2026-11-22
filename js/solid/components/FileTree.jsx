import { createSignal, createEffect, createMemo, For, Show, onMount, onCleanup } from 'solid-js';
import { state, activeDoc } from '../../core/state.js';
import {
  readDir, renamePath, removePath, trashPath, createFile, createDir,
  readBinaryFile, revealInExplorer, openExternal, askDialog, messageDialog, fileStamps,
} from '../../core/platform.js';
import { openTarget, looksBinary } from '../../core/file-kind.js';
import { openPath, openImageTab, pathRenamed, pathRemoved } from '../stores/docStore.js';
import { dirOf, joinPath, baseName, relativePath } from '../../core/paths.js';
import { t as tr } from '../../core/i18n.js';
import { openProjectFolder, closeProjectFolder, projectFolder } from '../stores/projectStore.js';
import { loadPdf } from '../../pdf/preview.js';
import { showContextMenu } from './ContextMenu.jsx';
import { icons } from './ribbon/icons.js';

/* ---- file-type icons (VSCode-style, colored by language) ---- */
const FI = {
  folder: (open) => `<svg viewBox="0 0 16 16"><path d="M1.5 3h4l1.5 1.5h7.5v8.5h-13z" fill="${open ? '#dcb67a' : '#c09553'}"/></svg>`,
  py: `<svg viewBox="0 0 16 16"><path d="M7.9 1.5c-2 0-2.6.9-2.6 2v1.4h2.7v.6H3.6c-1.2 0-2.1.9-2.1 2.5s.9 2.5 2.1 2.5h1.2V8.9c0-1.1 1-2 2.1-2h2.7c.9 0 1.7-.8 1.7-1.7V3.5c0-1.1-.9-2-3.4-2z" fill="#3776ab"/><path d="M8.1 14.5c2 0 2.6-.9 2.6-2v-1.4H8v-.6h4.4c1.2 0 2.1-.9 2.1-2.5s-.9-2.5-2.1-2.5h-1.2v1.6c0 1.1-1 2-2.1 2H6.4c-.9 0-1.7.8-1.7 1.7v1.7c0 1.1.9 2 3.4 2z" fill="#ffd43b"/></svg>`,
  ipynb: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.2" fill="none" stroke="#f37726" stroke-width="1.8"/><circle cx="3" cy="3.2" r="1.1" fill="#767677"/><circle cx="13" cy="12.8" r="1.1" fill="#989798"/></svg>`,
  tex: `<svg viewBox="0 0 16 16"><text x="8" y="11.6" font-size="9" font-weight="700" text-anchor="middle" fill="#3d8b3d" font-family="Georgia,serif">TeX</text></svg>`,
  // Pyx document (.pltx) — the brand file icon (archivo.svg).
  pltx: `<svg viewBox="0 0 125 170"><path d="M14 0.5H87.8145L124.5 32.2275V156C124.5 163.456 118.456 169.5 111 169.5H14C6.54416 169.5 0.5 163.456 0.5 156V14L0.504883 13.6514C0.689804 6.35665 6.66072 0.5 14 0.5Z" fill="#fff" stroke="#E2E8F0"/><path d="M29.25 49.2915C29.25 47.557 27.627 46.1509 25.625 46.1509C23.623 46.1509 22 47.557 22 49.2915V118.385C22 120.12 23.623 121.526 25.625 121.526C27.627 121.526 29.25 120.12 29.25 118.385V49.2915Z" fill="#0078D7"/><path d="M89.2 52.4321C89.2 33.5883 63.1 33.5883 63.1 58.7133V108.963C63.1 134.088 37 134.088 37 115.245" stroke="#E2E8F0" stroke-width="7" stroke-linecap="round"/><path d="M80 108.963L103.2 120.27L80 131.576V108.963Z" fill="#0078D7"/><path d="M88 1V26.125C88 29.6425 91.19 32.4063 95.25 32.4063H124.25L88 1Z" fill="#F8FAFC" stroke="#E2E8F0" stroke-linejoin="round"/></svg>`,
  pdf: `<svg viewBox="0 0 16 16"><path d="M3 1.5h7l3 3v10H3z" fill="#e2574c"/><text x="8" y="11.5" font-size="5.4" font-weight="700" text-anchor="middle" fill="#fff">PDF</text></svg>`,
  img: `<svg viewBox="0 0 16 16"><rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1" fill="#9068b0"/><circle cx="5.4" cy="6.2" r="1.2" fill="#ffe9a8"/><path d="m3.2 12 3.4-3.6 2.4 2.4 1.8-1.8 2.4 3z" fill="#d9c7ea"/></svg>`,
  cad: `<svg viewBox="0 0 16 16"><path d="M8 1.8 14 5v6l-6 3.2L2 11V5z" fill="none" stroke="#d35400" stroke-width="1.5"/><path d="M8 1.8V8m0 0L2 5m6 3 6-3" fill="none" stroke="#d35400" stroke-width="1.2"/></svg>`,
  code: `<svg viewBox="0 0 16 16"><path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5l3.5 3.5-3.5 3.5" fill="none" stroke="#519aba" stroke-width="1.6"/></svg>`,
  sheet: `<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="1.5" fill="#1d7044"/><path d="M2 6h12M2 10h12M6 2v12" stroke="#e8f5ec" stroke-width="1"/></svg>`,
  md: `<svg viewBox="0 0 16 16"><rect x="1" y="3.5" width="14" height="9" rx="1.5" fill="none" stroke="#519aba" stroke-width="1.3"/><path d="M3.5 10.5v-5l2 2.4 2-2.4v5M10.5 5.5v4.6m-1.6-1.6 1.6 1.7 1.6-1.7" fill="none" stroke="#519aba" stroke-width="1.2"/></svg>`,
  json: `<svg viewBox="0 0 16 16"><path d="M5.5 2.5c-1.5 0-2 .6-2 2v1.6c0 .9-.5 1.4-1.5 1.4v1c1 0 1.5.5 1.5 1.4v1.6c0 1.4.5 2 2 2M10.5 2.5c1.5 0 2 .6 2 2v1.6c0 .9.5 1.4 1.5 1.4v1c-1 0-1.5.5-1.5 1.4v1.6c0 1.4-.5 2-2 2" fill="none" stroke="#cbcb41" stroke-width="1.3"/></svg>`,
  bib: `<svg viewBox="0 0 16 16"><path d="M3 2.5h8.5l1.5 1.5v9.5H3z" fill="none" stroke="#c0843b" stroke-width="1.2"/><path d="M5 5.5h6M5 8h6M5 10.5h4" stroke="#c0843b" stroke-width="1.1"/></svg>`,
  text: `<svg viewBox="0 0 16 16"><path d="M3.5 1.5h6.5l2.5 2.5v10.5h-9z" fill="none" stroke="#8a99a8" stroke-width="1.2"/><path d="M5.5 6.5h5M5.5 9h5M5.5 11.5h3.5" stroke="#8a99a8" stroke-width="1.1"/></svg>`,
};

/* ---- VS Code's explorer actions (codicons, 16px) ---- */
const CI = {
  chevron: '<svg viewBox="0 0 16 16"><path d="M5.7 13.7 5 13l4.6-5L5 3.1l.7-.7L11 8z" fill="currentColor"/></svg>',
  newFile: '<svg viewBox="0 0 16 16"><path d="M9.5 1.1 13.9 5.5v3h-1V6H9V2H4v12h4v1H3V1h6.5zM10 2.4V5h2.6zM13 10h1v2h2v1h-2v2h-1v-2h-2v-1h2z" fill="currentColor"/></svg>',
  newFolder: '<svg viewBox="0 0 16 16"><path d="M14.5 3H7.7l-1-1H1.5l-.5.5v11l.5.5H8v-1H2V6h12v2h1V3.5zM2 5V3h4.3l1 1H14v1zm12 5h1v2h2v1h-2v2h-1v-2h-2v-1h2z" fill="currentColor"/></svg>',
  refresh: '<svg viewBox="0 0 16 16"><path d="M5.6 3.8A5 5 0 1 1 3 8H2a6 6 0 1 0 2.2-4.6V1.5h-1v3.5l.5.5h3.5v-1z" fill="currentColor"/></svg>',
  collapse: '<svg viewBox="0 0 16 16"><path d="M9 9H4v1h5zM7 12V7H6v5z" fill="currentColor" transform="rotate(45 6.5 9.5)"/><path d="M5 3h8.5l.5.5V12h-1V4H5zM2.5 5h8l.5.5v8l-.5.5h-8l-.5-.5v-8zM3 13h7V6H3z" fill="currentColor"/></svg>',
};

// What VS Code hides by default (files.exclude), plus Python's caches.
const HIDDEN = new Set(['.git', '.svn', '.hg', '.DS_Store', 'Thumbs.db', '__pycache__', '.ipynb_checkpoints']);
const byKind = (a, b) => (a.is_dir !== b.is_dir ? (a.is_dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff']);
const CAD_EXT = new Set(['dwg', 'dxf', 'step', 'stp', 'iges', 'igs', 'stl', '3dm']);
const TEXT_EXT = new Set(['txt', 'md', 'bib', 'csv', 'json', 'log', 'sty', 'cls', 'cfg', 'yml', 'yaml', 'toml']);
const CODE_EXT = new Set(['js', 'ts', 'jsx', 'tsx', 'rs', 'c', 'cpp', 'h', 'html', 'css', 'm', 'jl', 'r']);

function extOf(name) { return name.includes('.') ? name.split('.').pop().toLowerCase() : ''; }
function iconFor(item) {
  if (item.is_dir) return FI.folder(false);
  const e = extOf(item.name);
  if (e === 'pltx') return FI.pltx;
  if (e === 'py') return FI.py;
  if (e === 'ipynb') return FI.ipynb;
  if (e === 'tex') return FI.tex;
  if (e === 'pdf') return FI.pdf;
  if (IMG_EXT.has(e)) return FI.img;
  if (CAD_EXT.has(e)) return FI.cad;
  if (e === 'xlsx' || e === 'xlsm' || e === 'xls' || e === 'csv' || e === 'ods') return FI.sheet;
  if (e === 'md') return FI.md;
  if (e === 'json') return FI.json;
  if (e === 'bib') return FI.bib;
  if (CODE_EXT.has(e)) return FI.code;
  return FI.text;
}

export default function FileTree(props) {
  const [entries, setEntries] = createSignal(new Map()); // dir -> items[]
  const [expanded, setExpanded] = createSignal(new Set());
  const [selected, setSelected] = createSignal(null);    // full path
  const [renaming, setRenaming] = createSignal(null);    // full path being renamed
  const [creating, setCreating] = createSignal(null);    // { dir, isDir }
  let rootEl;

  const load = async (dir) => {
    try {
      const items = (await readDir(dir)).filter((x) => !HIDDEN.has(x.name)).sort(byKind);
      setEntries((m) => { const n = new Map(m); n.set(dir, items); return n; });
    } catch (_) { /* unreadable */ }
  };
  const refresh = (dir) => load(dir);

  createEffect(() => { if (props.root) load(props.root); });
  const [folded, setFolded] = createSignal(false); // the root section itself
  const collapseAll = () => setExpanded(new Set());
  const refreshAll = () => { load(props.root); for (const d of expanded()) load(d); };

  // The files on disk change behind Pyx's back (Explorer, Excel, a compile
  // writing figures): coming back to the window refreshes what is shown.
  onMount(() => {
    const onFocus = () => refreshAll();
    window.addEventListener('focus', onFocus);
    onCleanup(() => window.removeEventListener('focus', onFocus));
  });

  // The active document is highlighted, and its folders open to show it.
  const key = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  const activePath = createMemo(() => key(activeDoc()?.path));
  createEffect(() => {
    const a = activeDoc()?.path;
    const root = props.root;
    if (!a || !root || !key(a).startsWith(key(root) + '/')) return;
    const chain = [];
    for (let d = dirOf(a); d && key(d).length > key(root).length; d = dirOf(d)) chain.push(d);
    if (!chain.length) return;
    setExpanded((s0) => {
      const n = new Set(s0);
      for (const d of chain) { if (!n.has(d)) { n.add(d); if (!entries().get(d)) load(d); } }
      return n;
    });
  });
  // Unsaved changes in an open tab show on the file, as in VS Code.
  const modified = createMemo(() => new Set(state.documents.filter((d) => d.modified && d.path).map((d) => key(d.path))));

  const toggleDir = (path) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else { n.add(path); if (!entries().get(path)) load(path); }
      return n;
    });
  };

  const openFile = async (item) => {
    const e = extOf(item.name);
    if (e === 'pdf') {
      await loadPdf(item.path);
      state.previewVisible = true;
    } else if (IMG_EXT.has(e)) {
      const bytes = await readBinaryFile(item.path);
      const mime = e === 'svg' ? 'image/svg+xml' : `image/${e === 'jpg' ? 'jpeg' : e}`;
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      openImageTab(url, item.name);
    } else if (CAD_EXT.has(e)) {
      openExternal(item.path); // CAD opens in its native app
    } else {
      // Only TEXT goes to the editor (core/file-kind.js): a .zip or a video
      // opened there as text, and one Ctrl+S destroyed it.
      let size = -1;
      try { size = ((await fileStamps([item.path])) || [])[0]?.size ?? -1; } catch (_) { /* unknown */ }
      let target = openTarget(item.name, size);
      if (target === 'sniff') {
        try { target = looksBinary(await readBinaryFile(item.path)) ? 'external' : 'text'; } catch (_) { target = 'external'; }
      }
      if (target === 'text') openPath(item.path); // tex / py / text → editor tab
      else openExternal(item.path);               // its own program
    }
  };

  const startRename = (path) => { setSelected(path); setRenaming(path); };
  const commitRename = async (item, newName) => {
    // Enter commits and removes the input, whose blur then commits again:
    // only the first one counts.
    if (renaming() !== item.path) return;
    setRenaming(null);
    const name = (newName || '').trim();
    if (!name || name === item.name) return;
    // A name, not a path: "..\otro" or "sub/archivo" would move the file.
    if (/[\\/]/.test(name)) {
      await messageDialog(tr('El nombre no puede contener «\\» ni «/».', 'The name cannot contain “\\” or “/”.'), { title: tr('Renombrar', 'Rename'), kind: 'error' });
      return;
    }
    const to = joinPath(dirOf(item.path), name);
    try {
      await renamePath(item.path, to);
      pathRenamed(item.path, to); // open tabs follow the file
      refresh(dirOf(item.path));
    } catch (err) { await messageDialog(String(err), { title: tr('No se pudo renombrar', 'Could not rename'), kind: 'error' }); }
  };
  const doDelete = async (item) => {
    // Deleting a folder here removes it and everything under it, permanently.
    // That deserves the platform's own dialog, not a web prompt that some
    // WebView2 configurations suppress outright — a suppressed `confirm()`
    // returns false, so this used to fail closed, but the reverse of that bug
    // would have been silent data loss.
    //
    // On Windows it goes to the recycle bin, so a wrong click can be undone;
    // only when the bin cannot take it is a permanent delete offered, as a
    // second, explicit question.
    const what = `"${item.name}"${item.is_dir ? tr(' y todo su contenido', ' and everything in it') : ''}`;
    const bin = /Windows/i.test(navigator.userAgent || '');
    const ok = await askDialog(
      bin
        ? tr(`¿Enviar ${what} a la papelera de reciclaje?\n\n(En una unidad sin papelera, como muchas de red, se elimina definitivamente.)`,
          `Send ${what} to the recycle bin?\n\n(On a drive without a bin, like many network drives, it is deleted for good.)`)
        : tr(`¿Eliminar ${what}? Esta acción no se puede deshacer.`, `Delete ${what}? This cannot be undone.`),
      { title: tr('Eliminar', 'Delete'), kind: 'warning', okLabel: bin ? tr('Enviar a la papelera', 'Move to the bin') : tr('Eliminar', 'Delete'), cancelLabel: tr('Cancelar', 'Cancel') },
    );
    if (!ok) return;
    try {
      let done = false;
      if (bin) {
        try { await trashPath(item.path); done = true; } catch (err) {
          const forever = await askDialog(
            tr(`${String(err)}\n\n¿Eliminar ${what} definitivamente? Esta acción no se puede deshacer.`, `${String(err)}\n\nDelete ${what} for good? This cannot be undone.`),
            { title: tr('Eliminar', 'Delete'), kind: 'warning', okLabel: tr('Eliminar definitivamente', 'Delete for good'), cancelLabel: tr('Cancelar', 'Cancel') },
          );
          if (!forever) return;
        }
      }
      if (!done) await removePath(item.path);
      pathRemoved(item.path); // its tabs close, unless they hold unsaved text
      refresh(dirOf(item.path));
    } catch (err) {
      await messageDialog(String(err), { title: tr('No se pudo eliminar', 'Could not delete'), kind: 'error' });
    }
  };
  const commitCreate = async (name) => {
    const c = creating();
    setCreating(null);
    const n = (name || '').trim();
    if (!c || !n) return;
    const full = joinPath(c.dir, n);
    try {
      if (c.isDir) await createDir(full);
      else { await createFile(full); openPath(full); }
      refresh(c.dir);
      if (c.isDir) setExpanded((s) => new Set(s).add(c.dir));
    } catch (err) { await messageDialog(String(err), { kind: 'error' }); }
  };

  // «Copiar ruta relativa» answers what LaTeX needs: the path as seen from
  // the folder of the document being edited (\\input, \\includegraphics,
  // \\hoja…), forward slashes, `..` when it is elsewhere. With no document
  // open it is relative to the explorer's root folder.
  const copyText = (text) => {
    try { navigator.clipboard.writeText(text); } catch (_) { /* no clipboard */ }
  };
  const relBase = () => dirOf(activeDoc()?.path) || props.root;
  const nodeMenu = (e, item) => {
    const dir = item.is_dir ? item.path : dirOf(item.path);
    showContextMenu(e, [
      { label: tr('Abrir', 'Open'), icon: icons.open, onClick: () => (item.is_dir ? toggleDir(item.path) : openFile(item)) },
      { label: tr('Mostrar en el Explorador', 'Reveal in File Explorer'), icon: icons.folder, onClick: () => revealInExplorer(item.path) },
      { separator: true },
      { label: tr('Copiar ruta', 'Copy path'), icon: icons.copy, shortcut: tr('Mayús+Alt+C', 'Shift+Alt+C'), onClick: () => copyText(item.path) },
      { label: tr('Copiar ruta relativa', 'Copy relative path'), icon: icons.copy, shortcut: tr('Ctrl+Mayús+Alt+C', 'Ctrl+Shift+Alt+C'), onClick: () => copyText(relativePath(relBase(), item.path)) },
      { separator: true },
      { label: tr('Nuevo archivo…', 'New file…'), icon: icons.newFile, onClick: () => { setExpanded((s) => new Set(s).add(dir)); setCreating({ dir, isDir: false }); } },
      { label: tr('Nueva carpeta…', 'New folder…'), icon: icons.newFolder, onClick: () => { setExpanded((s) => new Set(s).add(dir)); setCreating({ dir, isDir: true }); } },
      { separator: true },
      { label: tr('Renombrar', 'Rename'), icon: icons.saveAs, shortcut: 'F2', onClick: () => startRename(item.path) },
      { label: tr('Eliminar', 'Delete'), icon: icons.trash, shortcut: tr('Supr', 'Del'), danger: true, onClick: () => doDelete(item) },
    ]);
  };
  const bgMenu = (e) => {
    showContextMenu(e, [
      { label: tr('Nuevo archivo…', 'New file…'), icon: icons.newFile, onClick: () => setCreating({ dir: props.root, isDir: false }) },
      { label: tr('Nueva carpeta…', 'New folder…'), icon: icons.newFolder, onClick: () => setCreating({ dir: props.root, isDir: true }) },
      { separator: true },
      { label: tr('Copiar ruta de la carpeta', 'Copy folder path'), icon: icons.copy, onClick: () => copyText(props.root) },
      { label: tr('Actualizar', 'Refresh'), icon: icons.refresh, onClick: () => refresh(props.root) },
    ]);
  };

  const findItem = (path) => {
    for (const items of entries().values()) {
      const f = items.find((x) => x.path === path);
      if (f) return f;
    }
    return null;
  };
  const onKey = (e) => {
    const sel = selected() && findItem(selected());
    if (!sel) return;
    if (e.key === 'F2') { e.preventDefault(); startRename(sel.path); }
    else if (e.key === 'Delete') { e.preventDefault(); doDelete(sel); }
    else if (e.key === 'Enter') { e.preventDefault(); sel.is_dir ? toggleDir(sel.path) : openFile(sel); }
    // VS Code's keys: Shift+Alt+C copies the path, Ctrl+Shift+Alt+C the relative one.
    else if ((e.key === 'c' || e.key === 'C') && e.shiftKey && e.altKey) {
      e.preventDefault();
      copyText(e.ctrlKey ? relativePath(relBase(), sel.path) : sel.path);
    }
  };

  const InlineInput = (p) => (
    <input
      class="ft-input"
      value={p.value || ''}
      ref={(el) => requestAnimationFrame(() => { el.focus(); el.select(); })}
      onKeyDown={(e) => {
        if (e.key === 'Enter') p.commit(e.target.value);
        else if (e.key === 'Escape') p.cancel();
        e.stopPropagation();
      }}
      onBlur={(e) => p.commit(e.target.value)}
      spellcheck={false}
    />
  );

  const INDENT = 8; // px per level, VS Code's workbench.tree.indent
  const Guides = (p) => (
    <For each={Array.from({ length: p.depth })}>
      {(_, k) => <span class="ft-guide" style={{ left: 12 + k() * INDENT + 'px' }} />}
    </For>
  );
  const Node = (p) => {
    const item = p.item;
    const isOpen = () => expanded().has(item.path);
    const isActive = () => !item.is_dir && key(item.path) === activePath();
    const isModified = () => !item.is_dir && modified().has(key(item.path));
    return (
      <>
        <div
          class={`ft-row${selected() === item.path ? ' selected' : ''}${isActive() ? ' active' : ''}${isModified() ? ' modified' : ''}`}
          style={{ 'padding-left': 4 + p.depth * INDENT + 'px' }}
          onClick={() => { setSelected(item.path); if (item.is_dir) toggleDir(item.path); else openFile(item); }}
          onContextMenu={(e) => { e.stopPropagation(); setSelected(item.path); nodeMenu(e, item); }}
          title={item.path}
        >
          <Guides depth={p.depth} />
          <span class={`ft-arrow${item.is_dir ? '' : ' leaf'}${isOpen() ? ' open' : ''}`} innerHTML={item.is_dir ? CI.chevron : ''} />
          <span class="ft-icon" innerHTML={item.is_dir ? FI.folder(isOpen()) : iconFor(item)}></span>
          <Show when={renaming() === item.path}
            fallback={<span class="ft-name">{item.name}</span>}>
            <InlineInput value={item.name} commit={(v) => commitRename(item, v)} cancel={() => setRenaming(null)} />
          </Show>
          <Show when={isModified()}><span class="ft-badge" title={tr('Cambios sin guardar', 'Unsaved changes')}>●</span></Show>
        </div>
        <Show when={item.is_dir && isOpen()}>
          <Show when={creating() && creating().dir === item.path}>
            <div class="ft-row" style={{ 'padding-left': 4 + (p.depth + 1) * INDENT + 'px' }}>
              <Guides depth={p.depth + 1} />
              <span class="ft-arrow leaf"></span>
              <span class="ft-icon" innerHTML={creating().isDir ? FI.folder(false) : FI.text}></span>
              <InlineInput commit={commitCreate} cancel={() => setCreating(null)} />
            </div>
          </Show>
          <For each={entries().get(item.path) || []}>
            {(child) => <Node item={child} depth={p.depth + 1} />}
          </For>
        </Show>
      </>
    );
  };

  const act = (icon, title, fn) => (
    <button class="ft-act" title={title} innerHTML={icon} onClick={(e) => { e.stopPropagation(); fn(); }} />
  );
  const isProject = () => !!projectFolder() && key(projectFolder()) === key(props.root);
  const headMenu = (e) => {
    e.stopPropagation();
    showContextMenu(e, [
      { label: tr('Nuevo archivo…', 'New file…'), icon: icons.newFile, onClick: () => { setFolded(false); setCreating({ dir: props.root, isDir: false }); } },
      { label: tr('Nueva carpeta…', 'New folder…'), icon: icons.newFolder, onClick: () => { setFolded(false); setCreating({ dir: props.root, isDir: true }); } },
      { label: tr('Mostrar en el Explorador', 'Reveal in File Explorer'), icon: icons.folder, onClick: () => revealInExplorer(props.root) },
      { separator: true },
      { label: tr('Abrir otra carpeta…', 'Open another folder…'), icon: icons.open, onClick: () => openProjectFolder() },
      ...(isProject() ? [{ label: tr('Cerrar carpeta', 'Close folder'), icon: icons.clear, onClick: () => closeProjectFolder() }] : []),
    ]);
  };

  return (
    <div class="file-tree" tabindex="0" onKeyDown={onKey} onContextMenu={bgMenu} ref={rootEl}>
      <div class="ft-head" onClick={() => setFolded(!folded())} onContextMenu={headMenu} title={props.root}>
        <span class={`ft-arrow${folded() ? '' : ' open'}`} innerHTML={CI.chevron} />
        <span class="ft-head-name">{baseName(props.root) || props.root}</span>
        <span class="ft-head-acts">
          {act(CI.newFile, tr('Nuevo archivo…', 'New file…'), () => { setFolded(false); setCreating({ dir: props.root, isDir: false }); })}
          {act(CI.newFolder, tr('Nueva carpeta…', 'New folder…'), () => { setFolded(false); setCreating({ dir: props.root, isDir: true }); })}
          {act(CI.refresh, tr('Actualizar el explorador', 'Refresh the explorer'), refreshAll)}
          {act(CI.collapse, tr('Contraer las carpetas', 'Collapse folders'), collapseAll)}
        </span>
      </div>
      <Show when={!folded()}>
        <Show when={creating() && creating().dir === props.root}>
          <div class="ft-row" style={{ 'padding-left': '4px' }}>
            <span class="ft-arrow leaf"></span>
            <span class="ft-icon" innerHTML={creating().isDir ? FI.folder(false) : FI.text}></span>
            <InlineInput commit={commitCreate} cancel={() => setCreating(null)} />
          </div>
        </Show>
        <For each={entries().get(props.root) || []}>
          {(item) => <Node item={item} depth={0} />}
        </For>
      </Show>
    </div>
  );
}
