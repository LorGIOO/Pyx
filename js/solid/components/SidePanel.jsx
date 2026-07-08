import { createMemo, For, Show } from 'solid-js';
import { state, activeDoc } from '../../core/state.js';
import { docText, parseTOC, parseIncludes } from '../stores/structureStore.js';
import { SYMBOL_CATEGORIES, insertText } from '../../data/symbols.js';
import { gotoLine, insertSnippet } from '../../editor/commands.js';
import { openPath } from '../stores/docStore.js';
import { dirOf, joinPath } from '../../core/paths.js';
import FileTree from './FileTree.jsx';

const I = {
  structure: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="9" y="3" width="6" height="4"/><rect x="3" y="17" width="6" height="4"/><rect x="15" y="17" width="6" height="4"/><path d="M12 7v5M6 17v-3h12v3"/></svg>',
  toc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  symbols: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 5h11l-5 7 5 7H6"/></svg>',
  files: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
};
const TABS = [
  { id: 'structure', label: 'Estructura', icon: I.structure },
  { id: 'toc', label: 'TOC', icon: I.toc },
  { id: 'symbols', label: 'Símbolos', icon: I.symbols },
  { id: 'files', label: 'Archivos', icon: I.files },
];
const KIND_SHORT = {
  part: 'P', chapter: 'C', section: 'S', subsection: 'ss',
  subsubsection: 'sss', paragraph: '¶', subparagraph: '¶¶',
};

const isText = (n) => /\.(tex|txt|bib|sty|cls|cfg|md|json|py)$/i.test(n);

export default function SidePanel() {
  const tab = () => state.sidePanelTab;
  const toggle = (id) => (state.sidePanelTab = state.sidePanelTab === id ? null : id);

  const toc = createMemo(() => parseTOC(docText()));
  const includes = createMemo(() => parseIncludes(docText()));
  const rootDir = createMemo(() => dirOf(activeDoc()?.path));

  const openInclude = (target) => {
    const base = dirOf(activeDoc()?.path);
    if (base) openPath(joinPath(base, target));
  };

  return (
    <div class="side-wrap">
      <div class="side-strip">
        <For each={TABS}>
          {(t) => (
            <button class={`side-ico${tab() === t.id ? ' active' : ''}`} title={t.label}
              innerHTML={t.icon} onClick={() => toggle(t.id)} />
          )}
        </For>
      </div>

      <Show when={tab()}>
        <div class="side-body">
          <div class="side-title">{TABS.find((t) => t.id === tab())?.label}</div>
          <div class="side-content">
            {/* TOC: sectioning tree, click to jump */}
            <Show when={tab() === 'toc'}>
              <Show when={toc().length} fallback={<div class="side-empty">Sin secciones todavía.</div>}>
                <For each={toc()}>
                  {(h) => (
                    <div class="toc-row" style={{ 'padding-left': 6 + h.level * 12 + 'px' }}
                      onClick={() => gotoLine(h.line)} title={`Línea ${h.line}`}>
                      <span class="toc-kind">{KIND_SHORT[h.kind]}{h.star ? '*' : ''}</span>
                      <span class="toc-title">{h.title}</span>
                    </div>
                  )}
                </For>
              </Show>
            </Show>

            {/* Estructura: this file and the documents it pulls in */}
            <Show when={tab() === 'structure'}>
              <div class="struct-root">📘 {activeDoc()?.fileName || 'sin documento'}</div>
              <Show when={includes().length}
                fallback={<div class="side-empty">No incluye otros archivos (\input, \include, \subfile).</div>}>
                <For each={includes()}>
                  {(inc) => (
                    <div class="struct-row" onClick={() => openInclude(inc.target)} title={`Abrir ${inc.target}`}>
                      <span class="struct-cmd">\{inc.cmd}</span>
                      <span class="struct-target">{inc.target}</span>
                    </div>
                  )}
                </For>
              </Show>
            </Show>

            {/* Símbolos: every category, click to insert */}
            <Show when={tab() === 'symbols'}>
              <For each={SYMBOL_CATEGORIES}>
                {(cat) => (
                  <div class="sym-cat">
                    <div class="sym-cat-name">{cat.name}</div>
                    <div class="sym-grid">
                      <For each={cat.items}>
                        {(it) => (
                          <button class="sym-btn" title={it[1]} onClick={() => insertSnippet(insertText(it[1]))}>
                            {it[0]}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </Show>

            {/* Archivos: VSCode-style explorer of the document's folder */}
            <Show when={tab() === 'files'}>
              <Show when={rootDir()} fallback={<div class="side-empty">Guarda el documento para ver su carpeta.</div>}>
                <FileTree root={rootDir()} />
              </Show>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
