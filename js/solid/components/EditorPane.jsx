import { onMount, onCleanup, createEffect, createSignal, createMemo, on, For, Show } from 'solid-js';
import { forceLinting } from '@codemirror/lint';
import { setProblemsSource } from '../../editor/latex-extras.js';
import { state, activeDoc } from '../../core/state.js';
import { mountPane, unmountPane, showDocInPane } from '../../editor/setup.js';
import { focusPane, showInPane, splitPane, closePane, isPyxDoc } from '../stores/docStore.js';
import {
  clip, pasteClipboard, selectAll, doUndo, doRedo, openFind, insertCell, gotoLine,
} from '../../editor/commands.js';
import { problems, gotoProblem } from '../stores/problemsStore.js';
import { t } from '../../core/i18n.js';
import { toc, crumbPath } from '../stores/structureStore.js';
import { getView, broadcastSpellRefresh, forEachEditorView } from '../../editor/setup.js';
import { spellInfoAt, addToUserDict } from '../../editor/spellcheck.js';
import { showContextMenu } from './ContextMenu.jsx';
import { icons } from './ribbon/icons.js';
import { setLastArea } from '../stores/previewStore.js';
import ImageViewerPane from './viewers/ImageViewerPane.jsx';
import HtmlViewerPane from './viewers/HtmlViewerPane.jsx';
import TerminalPanel from './TerminalPanel.jsx';

const DOC_MIME = 'application/x-calc-doc';

// Professional right-click menu for the editor (no browser/web menu).
function editorMenu(e) {
  // Spelling suggestions first (Word-style): if the click is on a misspelled
  // word, offer corrections, "add to dictionary" and "ignore".
  const view = getView();
  let spellItems = [];
  if (view) {
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const info = pos != null ? spellInfoAt(view, pos) : null;
    if (info) {
      const replace = (word) => {
        view.dispatch({ changes: { from: info.from, to: info.to, insert: word }, selection: { anchor: info.from + word.length } });
        view.focus();
      };
      // The corrections are WORDS, not commands. They get their own caption
      // and their own look (`suggestion`), because when they sat in the list
      // styled like "Cortar" and "Copiar" there was no way to tell at a
      // glance which rows would replace the word and which would act on it.
      spellItems = [
        { header: `Sugerencias para «${info.word}»` },
        ...(info.suggestions.length
          ? info.suggestions.map((s) => ({
            label: s, suggestion: true, icon: icons.replace, onClick: () => replace(s),
          }))
          : [{ label: 'Sin sugerencias', disabled: true, icon: icons.circleSlash, onClick: () => {} }]),
        { separator: true },
        {
          label: 'Agregar al diccionario',
          icon: icons.book,
          onClick: () => { addToUserDict(info.word); broadcastSpellRefresh(); },
        },
        { separator: true },
      ];
    }
  }
  const items = [
    ...spellItems,
    { label: 'Cortar', icon: icons.cut, shortcut: 'Ctrl+X', onClick: () => clip('cut') },
    { label: 'Copiar', icon: icons.copy, shortcut: 'Ctrl+C', onClick: () => clip('copy') },
    { label: 'Pegar', icon: icons.paste, shortcut: 'Ctrl+V', onClick: () => pasteClipboard() },
    { separator: true },
    { label: 'Seleccionar todo', icon: icons.selectAll, shortcut: 'Ctrl+A', onClick: () => selectAll() },
    { separator: true },
    { label: 'Deshacer', icon: icons.undo, shortcut: 'Ctrl+Z', onClick: () => doUndo() },
    { label: 'Rehacer', icon: icons.redo, shortcut: 'Ctrl+Y', onClick: () => doRedo() },
    { separator: true },
    { label: 'Buscar…', icon: icons.find, shortcut: 'Ctrl+F', onClick: () => openFind() },
  ];
  // Python cells are a Pyx (.pltx) capability — hidden for plain .tex.
  if (isPyxDoc(activeDoc())) {
    items.push({ label: 'Nueva celda Python', icon: icons.cell, shortcut: 'Ctrl+Alt+C', onClick: () => insertCell() });
  }
  showContextMenu(e, items);
}

// One editor split: hosts its own CodeMirror view; renders a viewer instead
// when its document is an image/html output tab. Accepts tab drops (left side
// = open here, right edge = split, VSCode-style).
function Pane(props) {
  let hostRef;
  const [dropZone, setDropZone] = createSignal(null); // null | 'center' | 'right'

  const doc = () => state.documents.find((d) => d.id === props.pane.docId) || null;
  const isViewer = () => { const d = doc(); return !!(d && d.kind); };

  onMount(() => mountPane(props.pane.id, hostRef));
  onCleanup(() => unmountPane(props.pane.id));

  // Show the pane's document in its editor whenever it changes (text docs only).
  createEffect(() => {
    const d = doc();
    if (d && !d.kind) showDocInPane(props.pane.id, d.id);
  });

  const onDragOver = (e) => {
    if (!e.dataTransfer.types.includes(DOC_MIME)) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setDropZone(e.clientX > rect.right - rect.width * 0.25 ? 'right' : 'center');
  };
  const onDrop = (e) => {
    const id = parseInt(e.dataTransfer.getData(DOC_MIME), 10);
    const zone = dropZone();
    setDropZone(null);
    if (!id) return;
    e.preventDefault();
    if (zone === 'right') splitPane(props.pane.id, id);
    else showInPane(props.pane.id, id);
  };

  return (
    <div
      class={`editor-split${state.activePaneId === props.pane.id ? ' focused' : ''}`}
      onMouseDown={() => { focusPane(props.pane.id); setLastArea('editor'); }}
      onContextMenu={(e) => { if (!isViewer()) editorMenu(e); }}
      onDragOver={onDragOver}
      onDragLeave={() => setDropZone(null)}
      onDrop={onDrop}
    >
      <Show when={state.panes.length > 1}>
        <button class="split-close" title="Cerrar panel"
          onClick={(e) => { e.stopPropagation(); closePane(props.pane.id); }}>×</button>
      </Show>

      <div class="editor-host" ref={hostRef} style={{ display: isViewer() ? 'none' : 'block' }}></div>

      <Show when={isViewer()}>
        <Show when={doc().kind === 'image'}>
          <ImageViewerPane src={doc().payload.src} />
        </Show>
        <Show when={doc().kind === 'html'}>
          <HtmlViewerPane html={doc().payload.html} />
        </Show>
      </Show>

      <Show when={dropZone()}>
        <div class={`drop-hint ${dropZone()}`}></div>
      </Show>
    </div>
  );
}

// VS Code's codicons for the problems list.
const CHEVRON = '<svg viewBox="0 0 16 16"><path d="M5.7 13.7 5 13l4.6-5L5 3.1l.7-.7L11 8z" fill="currentColor"/></svg>';
const SEV_ICON = {
  error: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="m5.6 5.6 4.8 4.8m0-4.8-4.8 4.8" stroke="currentColor" stroke-width="1.1"/></svg>',
  warning: '<svg viewBox="0 0 16 16"><path d="M8 1.8 14.8 14H1.2z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M8 6v4.2M8 11.4v1.2" stroke="currentColor" stroke-width="1.2"/></svg>',
  badbox: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M8 7v4.6M8 4.6v1.2" stroke="currentColor" stroke-width="1.2"/></svg>',
};
SEV_ICON.info = SEV_ICON.badbox;

// Short display name for a problem's source file (TeXstudio shows it too).
const fileBase = (f) => (f ? String(f).split(/[\\/]/).pop() : '');

// One problem as a TeXstudio-style text line: "file:line: message" (line/file
// omitted when unknown), so a copied problem reads exactly like TeXstudio's.
function problemText(p) {
  const loc = [fileBase(p.file), p.line].filter(Boolean).join(':');
  return loc ? `${loc}: ${p.message}` : p.message;
}
async function copyText(str) {
  try { await navigator.clipboard.writeText(str); return true; }
  catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = str; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); return true;
    } catch (_2) { return false; }
  }
}

export default function EditorPane() {
  const statusLabel = () =>
    state.lastCompileOk === false ? t(' · sin PDF', ' · no PDF')
    : state.lastCompileOk === 'warn' ? t(' · PDF generado con errores', ' · PDF built with errors')
    : state.lastCompileOk === true ? t(' · correcto', ' · succeeded')
    : '';
  const [logView, setLogView] = createSignal('problems'); // 'problems' | 'raw'
  // Problems grouped by file, VS Code's way (errors first inside each group).
  const [foldedGroups, setFoldedGroups] = createSignal(new Set());
  const toggleGroup = (k) => setFoldedGroups((s0) => { const n = new Set(s0); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const problemGroups = createMemo(() => {
    const rank = { error: 0, warning: 1, badbox: 2 };
    const groups = new Map();
    for (const p of problems()) {
      const key = p.file || '';
      if (!groups.has(key)) {
        const parts = String(p.file || '').split(/[\\/]/);
        groups.set(key, { key, file: p.file, dir: parts.length > 1 ? parts.slice(-2, -1)[0] : '', items: [] });
      }
      groups.get(key).items.push(p);
    }
    for (const g of groups.values()) g.items.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
    return [...groups.values()];
  });
  // The problems of the last compile are parsed once, in problemsStore.js,
  // and shared with the compile LED and the status bar.
  // The same problems underlined on their lines in the editor (TeXstudio's
  // log markers): the linter reads them, and a new log re-lints every pane.
  setProblemsSource(problems);
  createEffect(on(problems, () => forEachEditorView((v) => forceLinting(v)), { defer: true }));

  // VSCode-style breadcrumbs: the section path containing the cursor, from the
  // shared TOC (parsed once by the store, not re-parsed here). Walking the TOC
  // for the cursor's path is O(sections), so this stays cheap on cursor moves.
  const crumbs = createMemo(() => crumbPath(toc(), state.cursor.line));

  return (
    <>
      {/* Hidden, not removed, when empty or in zen mode: inserted before the
          editor, it made Solid move the editor in the DOM, and the editor
          lost its scroll position (back to the top). */}
      <div class="breadcrumbs" classList={{ 'is-hidden': !crumbs().length || state.zenMode }}>
        <For each={crumbs()}>
          {(h, i) => (
            <>
              <Show when={i() > 0}><span class="crumb-sep">›</span></Show>
              <span class="crumb" onClick={() => gotoLine(h.line)}
                title={t(`Línea ${h.line}`, `Line ${h.line}`)}>{h.title}</span>
            </>
          )}
        </For>
      </div>
      <div class="editor-splits">
        <For each={state.panes}>{(pane) => <Pane pane={pane} />}</For>
      </div>
      <Show when={state.logVisible}>
        <div class="log-panel">
          <div class="log-panel-header">
            <div class="log-tabs">
              <button class={logView() === 'problems' ? 'active' : ''} onClick={() => setLogView('problems')}>
                {t('Problemas', 'Problems')}
                <Show when={problems().length}><span class="log-badge">{problems().length}</span></Show>
              </button>
              <button class={logView() === 'raw' ? 'active' : ''} onClick={() => setLogView('raw')}>{t('Salida', 'Output')}</button>
            </div>
            <span class="log-status">{statusLabel()}</span>
            <Show when={logView() === 'problems' ? problems().length : state.lastLog}>
              <button class="log-copy"
                title={t('Copiar todo (formato TeXstudio)', 'Copy all (TeXstudio format)')}
                onClick={() => copyText(
                  logView() === 'problems'
                    ? problems().map(problemText).join('\n')
                    : (state.lastLog || ''),
                )}>{t('Copiar', 'Copy')}</button>
            </Show>
            <button class="log-close" onClick={() => (state.logVisible = false)} title={t('Cerrar', 'Close')}>×</button>
          </div>
          <Show when={logView() === 'problems'}
            fallback={<pre>{state.lastLog || t('Sin registro todavía. Compila el documento para ver la salida del motor LaTeX.', 'No log yet. Compile the document to see the LaTeX engine output.')}</pre>}>
            <div class="log-problems">
              <Show when={problems().length}
                fallback={<div class="log-empty">{state.lastLog ? t('✓ Sin errores ni avisos detectados.', '✓ No errors or warnings detected.') : t('Compila el documento para ver los problemas.', 'Compile the document to see the problems.')}</div>}>
                <For each={problemGroups()}>
                  {(g) => (
                    <div class="log-group">
                      {/* VS Code groups the problems by file, foldable, with a count. */}
                      <div class="log-group-head" onClick={() => toggleGroup(g.key)} title={g.file || ''}>
                        <span class={`log-chev${foldedGroups().has(g.key) ? '' : ' open'}`} innerHTML={CHEVRON} />
                        <span class="log-group-name">{g.file ? fileBase(g.file) : t('Documento', 'Document')}</span>
                        <Show when={g.dir}><span class="log-group-dir">{g.dir}</span></Show>
                        <span class="log-badge">{g.items.length}</span>
                      </div>
                      <Show when={!foldedGroups().has(g.key)}>
                        <For each={g.items}>
                          {(p) => (
                            // A problem's line is a line of ITS file, so the click
                            // opens that file first (gotoProblem).
                            <div class={`log-item ${p.severity}`} classList={{ clickable: !!p.line }}
                              title={p.line ? t(`Ir a la línea ${p.line} · clic derecho para copiar`, `Go to line ${p.line} · right-click to copy`) : t('Clic derecho para copiar', 'Right-click to copy')}
                              onClick={() => p.line && gotoProblem(p)}
                              onContextMenu={(e) => { e.preventDefault(); copyText(problemText(p)); }}>
                              <span class="log-sev" innerHTML={SEV_ICON[p.severity] || SEV_ICON.info} />
                              <span class="log-msg">{p.message}</span>
                              <span class="log-src">LaTeX</span>
                              <Show when={p.line}><span class="log-line">[{t('Ln', 'Ln')} {p.line}]</span></Show>
                            </div>
                          )}
                        </For>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={state.terminalVisible}>
        <TerminalPanel />
      </Show>
    </>
  );
}
