import { onMount, onCleanup, createEffect, createSignal, createMemo, For, Show } from 'solid-js';
import { state, activeDoc } from '../../core/state.js';
import { mountPane, unmountPane, showDocInPane } from '../../editor/setup.js';
import { focusPane, showInPane, splitPane, closePane, isPyxDoc } from '../stores/docStore.js';
import {
  clip, pasteClipboard, selectAll, doUndo, doRedo, openFind, insertCell, gotoLine,
} from '../../editor/commands.js';
import { parseLatexLog } from '../../compile/log-parser.js';
import { t } from '../../core/i18n.js';
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
    state.lastCompileOk === false ? t(' · con errores', ' · with errors')
    : state.lastCompileOk === true ? t(' · correcto', ' · succeeded')
    : '';
  const [logView, setLogView] = createSignal('problems'); // 'problems' | 'raw'
  // TeXstudio-fidelity parse: file attribution via the log's parenthesis stack,
  // with Pyx's .build copies mapped back to the real files.
  const problems = createMemo(() => parseLatexLog(state.lastLog, {
    rootFile: state.lastRootFile || null,
    buildMap: state.lastBuildMap || null,
    knownFiles: state.lastKnownFiles ? new Set(state.lastKnownFiles) : null,
  }));
  const sevIcon = (s) => (s === 'error' ? '✕' : s === 'badbox' ? '▭' : '!');

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
                <For each={problems()}>
                  {(p) => (
                    <div class={`log-item ${p.severity}`} classList={{ clickable: !!p.line }}
                      title={p.line ? t(`Ir a la línea ${p.line} · clic derecho para copiar`, `Go to line ${p.line} · right-click to copy`) : t('Clic derecho para copiar', 'Right-click to copy')}
                      onClick={() => p.line && gotoLine(p.line)}
                      onContextMenu={(e) => { e.preventDefault(); copyText(problemText(p)); }}>
                      <span class="log-sev">{sevIcon(p.severity)}</span>
                      <Show when={p.file}><span class="log-file">{fileBase(p.file)}</span></Show>
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
