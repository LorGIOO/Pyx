import { createSignal, createEffect, For, Show } from 'solid-js';
import { state } from '../../core/state.js';
import {
  readDir, renamePath, removePath, createFile, createDir,
  readBinaryFile, revealInExplorer, openExternal,
} from '../../core/platform.js';
import { openPath, openImageTab } from '../stores/docStore.js';
import { dirOf, joinPath } from '../../core/paths.js';
import { loadPdf } from '../../pdf/preview.js';
import { showContextMenu } from './ContextMenu.jsx';

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
  text: `<svg viewBox="0 0 16 16"><path d="M3.5 1.5h6.5l2.5 2.5v10.5h-9z" fill="none" stroke="#8a99a8" stroke-width="1.2"/><path d="M5.5 6.5h5M5.5 9h5M5.5 11.5h3.5" stroke="#8a99a8" stroke-width="1.1"/></svg>`,
};

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
      const items = await readDir(dir);
      setEntries((m) => { const n = new Map(m); n.set(dir, items); return n; });
    } catch (_) { /* unreadable */ }
  };
  const refresh = (dir) => load(dir);

  createEffect(() => { if (props.root) load(props.root); });

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
      openPath(item.path); // tex / py / text → editor tab
    }
  };

  const startRename = (path) => { setSelected(path); setRenaming(path); };
  const commitRename = async (item, newName) => {
    setRenaming(null);
    const name = (newName || '').trim();
    if (!name || name === item.name) return;
    try {
      await renamePath(item.path, joinPath(dirOf(item.path), name));
      refresh(dirOf(item.path));
    } catch (err) { alert(String(err)); }
  };
  const doDelete = async (item) => {
    if (!window.confirm(`¿Eliminar "${item.name}"${item.is_dir ? ' y todo su contenido' : ''}?`)) return;
    try {
      await removePath(item.path);
      refresh(dirOf(item.path));
    } catch (err) { alert(String(err)); }
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
    } catch (err) { alert(String(err)); }
  };

  const nodeMenu = (e, item) => {
    const dir = item.is_dir ? item.path : dirOf(item.path);
    showContextMenu(e, [
      { label: 'Abrir', onClick: () => (item.is_dir ? toggleDir(item.path) : openFile(item)) },
      { label: 'Mostrar en el Explorador', onClick: () => revealInExplorer(item.path) },
      { separator: true },
      { label: 'Nuevo archivo…', onClick: () => { setExpanded((s) => new Set(s).add(dir)); setCreating({ dir, isDir: false }); } },
      { label: 'Nueva carpeta…', onClick: () => { setExpanded((s) => new Set(s).add(dir)); setCreating({ dir, isDir: true }); } },
      { separator: true },
      { label: 'Renombrar', shortcut: 'F2', onClick: () => startRename(item.path) },
      { label: 'Eliminar', shortcut: 'Supr', danger: true, onClick: () => doDelete(item) },
    ]);
  };
  const bgMenu = (e) => {
    showContextMenu(e, [
      { label: 'Nuevo archivo…', onClick: () => setCreating({ dir: props.root, isDir: false }) },
      { label: 'Nueva carpeta…', onClick: () => setCreating({ dir: props.root, isDir: true }) },
      { separator: true },
      { label: 'Actualizar', onClick: () => refresh(props.root) },
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

  const Node = (p) => {
    const item = p.item;
    const isOpen = () => expanded().has(item.path);
    return (
      <>
        <div
          class={`ft-row${selected() === item.path ? ' selected' : ''}`}
          style={{ 'padding-left': 6 + p.depth * 14 + 'px' }}
          onClick={() => { setSelected(item.path); if (item.is_dir) toggleDir(item.path); else openFile(item); }}
          onContextMenu={(e) => nodeMenu(e, item)}
          title={item.path}
        >
          <Show when={item.is_dir} fallback={<span class="ft-arrow"></span>}>
            <span class={`ft-arrow${isOpen() ? ' open' : ''}`}>▸</span>
          </Show>
          <span class="ft-icon" innerHTML={item.is_dir ? FI.folder(isOpen()) : iconFor(item)}></span>
          <Show when={renaming() === item.path}
            fallback={<span class="ft-name">{item.name}</span>}>
            <InlineInput value={item.name} commit={(v) => commitRename(item, v)} cancel={() => setRenaming(null)} />
          </Show>
        </div>
        <Show when={item.is_dir && isOpen()}>
          <Show when={creating() && creating().dir === item.path}>
            <div class="ft-row" style={{ 'padding-left': 6 + (p.depth + 1) * 14 + 'px' }}>
              <span class="ft-arrow"></span>
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

  return (
    <div class="file-tree" tabindex="0" onKeyDown={onKey} onContextMenu={bgMenu} ref={rootEl}>
      <div class="ft-actions">
        <button title="Nuevo archivo" onClick={() => setCreating({ dir: props.root, isDir: false })}>+📄</button>
        <button title="Nueva carpeta" onClick={() => setCreating({ dir: props.root, isDir: true })}>+📁</button>
        <button title="Actualizar" onClick={() => refresh(props.root)}>⟳</button>
      </div>
      <Show when={creating() && creating().dir === props.root}>
        <div class="ft-row" style={{ 'padding-left': '6px' }}>
          <span class="ft-arrow"></span>
          <span class="ft-icon" innerHTML={creating().isDir ? FI.folder(false) : FI.text}></span>
          <InlineInput commit={commitCreate} cancel={() => setCreating(null)} />
        </div>
      </Show>
      <For each={entries().get(props.root) || []}>
        {(item) => <Node item={item} depth={0} />}
      </For>
    </div>
  );
}
