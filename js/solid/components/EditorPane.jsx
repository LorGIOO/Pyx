import { onMount, onCleanup, createEffect, createSignal, createMemo, For, Show } from 'solid-js';
import { state, activeDoc } from '../../core/state.js';
import { mountPane, unmountPane, showDocInPane } from '../../editor/setup.js';
import { focusPane, showInPane, splitPane, closePane, isPyxDoc } from '../stores/docStore.js';
import {
  clip, pasteClipboard, selectAll, doUndo, doRedo, openFind, insertCell, gotoLine,
} from '../../editor/commands.js';
import { parseLatexLog } from '../../compile/log-parser.js';
import { getView, broadcastSpellRefresh } from '../../editor/setup.js';
import { spellInfoAt, addToUserDict } from '../../editor/spellcheck.js';
import { showContextMenu } from './ContextMenu.jsx';
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
      spellItems = [
        ...(info.suggestions.length
          ? info.suggestions.map((s) => ({ label: s, bold: true, onClick: () => replace(s) }))
          : [{ label: '(sin sugerencias)', disabled: true, onClick: () => {} }]),
        { separator: true },
        { label: 'Agregar al diccionario', onClick: () => { addToUserDict(info.word); broadcastSpellRefresh(); } },
        { separator: true },
      ];
    }
  }
  const items = [
    ...spellItems,
    { label: 'Cortar', shortcut: 'Ctrl+X', onClick: () => clip('cut') },
    { label: 'Copiar', shortcut: 'Ctrl+C', onClick: () => clip('copy') },
    { label: 'Pegar', shortcut: 'Ctrl+V', onClick: () => pasteClipboard() },
    { separator: true },
    { label: 'Seleccionar todo', shortcut: 'Ctrl+A', onClick: () => selectAll() },
    { separator: true },
    { label: 'Deshacer', shortcut: 'Ctrl+Z', onClick: () => doUndo() },
    { label: 'Rehacer', shortcut: 'Ctrl+Y', onClick: () => doRedo() },
    { separator: true },
    { label: 'Buscar…', shortcut: 'Ctrl+F', onClick: () => openFind() },
  ];
  // Python cells are a Pyx (.pltx) capability — hidden for plain .tex.
  if (isPyxDoc(activeDoc())) {
    items.push({ label: 'Nueva celda Python', shortcut: 'Ctrl+Alt+C', onClick: () => insertCell() });
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

export default function EditorPane() {
  const statusLabel = () =>
    state.lastCompileOk === false ? ' · con errores'
    : state.lastCompileOk === true ? ' · correcto'
    : '';
  const [logView, setLogView] = createSignal('problems'); // 'problems' | 'raw'
  const problems = createMemo(() => parseLatexLog(state.lastLog));

  return (
    <>
      <div class="editor-splits">
        <For each={state.panes}>{(pane) => <Pane pane={pane} />}</For>
      </div>
      <Show when={state.logVisible}>
        <div class="log-panel">
          <div class="log-panel-header">
            <div class="log-tabs">
              <button class={logView() === 'problems' ? 'active' : ''} onClick={() => setLogView('problems')}>
                Problemas
                <Show when={problems().length}><span class="log-badge">{problems().length}</span></Show>
              </button>
              <button class={logView() === 'raw' ? 'active' : ''} onClick={() => setLogView('raw')}>Salida</button>
            </div>
            <span class="log-status">{statusLabel()}</span>
            <button class="log-close" onClick={() => (state.logVisible = false)} title="Cerrar">×</button>
          </div>
          <Show when={logView() === 'problems'}
            fallback={<pre>{state.lastLog || 'Sin registro todavía. Compila el documento para ver la salida del motor LaTeX.'}</pre>}>
            <div class="log-problems">
              <Show when={problems().length}
                fallback={<div class="log-empty">{state.lastLog ? '✓ Sin errores ni avisos detectados.' : 'Compila el documento para ver los problemas.'}</div>}>
                <For each={problems()}>
                  {(p) => (
                    <div class={`log-item ${p.severity}`} classList={{ clickable: !!p.line }}
                      title={p.line ? `Ir a la línea ${p.line}` : ''}
                      onClick={() => p.line && gotoLine(p.line)}>
                      <span class="log-sev">{p.severity === 'error' ? '✕' : '!'}</span>
                      <span class="log-msg">{p.message}</span>
                      <Show when={p.line}><span class="log-line">L{p.line}</span></Show>
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
