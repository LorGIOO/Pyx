import { createMemo, For, Show } from 'solid-js';
import { state, activeDoc } from '../../core/state.js';
import { t as tr } from '../../core/i18n.js';
import { toc, todos, includes, crumbPath } from '../stores/structureStore.js';
import { SYMBOL_CATEGORIES, insertText } from '../../data/symbols.js';
import { gotoLine, insertSnippet } from '../../editor/commands.js';
import { openPath } from '../stores/docStore.js';
import { dirOf, joinPath } from '../../core/paths.js';
import FileTree from './FileTree.jsx';

// Side-strip icons, same hand as the ribbon (16x16, 1.2px strokes). The
// codicon each one is modelled on is named in the comment.
const S = 'viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"';
const I = {
  // codicon: list-tree — the file and the documents it pulls in
  structure: `<svg ${S}><path d="M2 3.2h12"/><path d="M3.6 4.8v6.4"/><path d="M3.6 7.4h2.4M6.4 7.4H14M3.6 11.2h2.4M6.4 11.2H14"/></svg>`,
  // codicon: list-unordered
  toc: `<svg ${S}><path d="M5.4 3.4h9M5.4 8h9M5.4 12.6h9"/><path d="M2.5 3.4h.01M2.5 8h.01M2.5 12.6h.01" stroke-width="2"/></svg>`,
  // codicon: symbol-operator
  symbols: `<svg ${S}><path d="M11.6 3.6V2.5H4.5L8.2 8l-3.7 5.5h7.1v-1.1"/></svg>`,
  // codicon: files
  files: `<svg ${S}><path d="M5.5 1.5h4L12.5 4.5v8a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"/><path d="M9.5 1.5v3h3"/><path d="M2.5 4.2v9.3a1 1 0 0 0 1 1H10"/></svg>`,
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

  // toc / todos / includes are recomputed off the typing path by the store (one
  // scheduled pass), so the panel just reads them.
  const rootDir = createMemo(() => dirOf(activeDoc()?.path));
  // The section that contains the CURSOR (TeXstudio highlights it in the tree).
  const activeLine = createMemo(() => {
    const path = crumbPath(toc(), state.cursor.line);
    return path.length ? path[path.length - 1].line : -1;
  });

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
            {/* TOC: sectioning tree, click to jump; the cursor's section is
                highlighted (TeXstudio-style); TODO/FIXME entries listed below. */}
            <Show when={tab() === 'toc'}>
              <Show when={toc().length} fallback={<div class="side-empty">{tr('Sin secciones todavía.', 'No sections yet.')}</div>}>
                <For each={toc()}>
                  {(h) => (
                    <div class="toc-row" classList={{ active: h.line === activeLine() }}
                      style={{ 'padding-left': 6 + h.level * 12 + 'px' }}
                      onClick={() => gotoLine(h.line)} title={tr(`Línea ${h.line}`, `Line ${h.line}`)}>
                      <span class="toc-kind">{KIND_SHORT[h.kind]}{h.star ? '*' : ''}</span>
                      <span class="toc-title">{h.title}</span>
                    </div>
                  )}
                </For>
              </Show>
              <Show when={todos().length}>
                <div class="sym-cat-name" style={{ 'margin-top': '10px' }}>TODO</div>
                <For each={todos()}>
                  {(td) => (
                    <div class="toc-row todo" onClick={() => gotoLine(td.line)}
                      title={tr(`Línea ${td.line}`, `Line ${td.line}`)}>
                      <span class="toc-kind">!</span>
                      <span class="toc-title">{td.text || td.tag}</span>
                    </div>
                  )}
                </For>
              </Show>
            </Show>

            {/* Estructura: this file and the documents it pulls in */}
            <Show when={tab() === 'structure'}>
              <div class="struct-root">
                {/* `pyx-ico` is what gives an inline SVG a size: without it the
                    icon had no rule of its own and filled the whole panel. */}
                <span class="struct-root-ico pyx-ico" innerHTML={I.files}></span>
                <span class="struct-root-name">
                  {activeDoc()?.fileName || tr('sin documento', 'no document')}
                </span>
              </div>
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
