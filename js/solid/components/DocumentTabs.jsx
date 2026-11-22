import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { state } from '../../core/state.js';
import { t } from '../../core/i18n.js';
import { switchTo, closeDocument, moveDocument } from '../stores/docStore.js';
import { openNewDoc } from './NewDocDialog.jsx';
import { icons } from './ribbon/icons.js';
import { gv } from '../stores/settingsStore.js';
import CompileLed from './CompileLed.jsx';

const DOC_MIME = 'application/x-calc-doc';
// Reordering: which tab is being dragged and where it would land
// ({ index, after }: drop before or after that tab).
const [dragFrom, setDragFrom] = createSignal(-1);
const [dropAt, setDropAt] = createSignal(null);

export default function DocumentTabs() {
  let scrollEl;
  let addEl;

  // The active tab is always in view. Switching document from anywhere else —
  // the side panel, a SyncTeX click, Ctrl+W closing the one in front — used to
  // leave the strip where it was, with the active tab scrolled out of sight.
  // Done by hand on the strip's own scrollLeft: scrollIntoView() would also
  // scroll every scrollable ancestor it can find.
  const reveal = () => {
    const i = state.activeIndex;
    void state.documents.length;
    if (!scrollEl) return;
    const tab = scrollEl.children[i];
    if (!tab || !tab.classList.contains('doc-tab')) return;
    // The "+" is pinned over the right end of the strip: a tab under it is
    // not in view.
    const room = scrollEl.clientWidth - (addEl ? addEl.offsetWidth : 0);
    const left = tab.offsetLeft - scrollEl.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < scrollEl.scrollLeft) scrollEl.scrollLeft = left;
    else if (right > scrollEl.scrollLeft + room) scrollEl.scrollLeft = right - room;
  };
  createEffect(reveal);
  // A narrower window narrows the strip under the active tab as well.
  window.addEventListener('resize', reveal);
  onCleanup(() => window.removeEventListener('resize', reveal));

  return (
    <div class="document-tabs">
      {/* The strip scrolls when the tabs do not fit; the "+" at its end does
          not (position: sticky): it sits right after the last tab while there
          is room and stays at the right edge once there is not. With many
          documents open it used to scroll out of reach with the tabs. */}
      <div class="doc-tabs-scroll" ref={scrollEl}>
      <For each={state.documents}>
        {(doc, i) => (
          <div
            class={`doc-tab${i() === state.activeIndex ? ' active' : ''}${doc.modified ? ' modified' : ''}`}
            classList={{
              dragging: dragFrom() === i(),
              'drop-before': dropAt()?.index === i() && !dropAt().after,
              'drop-after': dropAt()?.index === i() && dropAt().after,
            }}
            onClick={() => switchTo(i())}
            // Middle button (the wheel) closes the tab, as in a browser or VS Code.
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              closeDocument(i());
            }}
            title={doc.path || doc.fileName}
            draggable={true}
            onDragStart={(e) => {
              // Drag a tab onto an editor pane (VSCode-style): drop on the
              // middle = open there, drop on the right edge = split. Dropped
              // on the strip itself it is moved to a new place among the tabs.
              e.dataTransfer.setData(DOC_MIME, String(doc.id));
              e.dataTransfer.effectAllowed = 'move';
              setDragFrom(i());
            }}
            onDragOver={(e) => {
              if (dragFrom() < 0) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const r = e.currentTarget.getBoundingClientRect();
              setDropAt({ index: i(), after: e.clientX > r.left + r.width / 2 });
            }}
            onDrop={(e) => {
              const from = dragFrom();
              const at = dropAt();
              if (from < 0 || !at) return;
              e.preventDefault();
              e.stopPropagation();
              let to = at.index + (at.after ? 1 : 0);
              if (from < to) to -= 1;
              moveDocument(from, to);
              setDragFrom(-1); setDropAt(null);
            }}
            onDragEnd={() => { setDragFrom(-1); setDropAt(null); }}
          >
            <span class="doc-tab-name">{doc.fileName}</span>
            {/* codicon: close */}
            <button
              class="doc-tab-close pyx-ico"
              title={t('Cerrar', 'Close')}
              innerHTML={icons.close}
              onClick={(e) => {
                e.stopPropagation();
                closeDocument(i());
              }}
            />
          </div>
        )}
      </For>
      {/* codicon: add */}
      <button class="doc-tab-add pyx-ico" ref={addEl} title={t('Nuevo documento (Ctrl+N)', 'New document (Ctrl+N)')}
        innerHTML={icons.add} onClick={openNewDoc} />
      </div>
      {/* The fixed end of the strip: it never scrolls and never shrinks, so
          what sits here is always in sight. In zen mode that is the compile
          LED — the strip is the only chrome zen keeps (Configuración →
          Compilación can show it outside zen too). */}
      <div class="doc-tabs-end">
        <Show when={(state.zenMode || gv('ledAlways') === true) && state.documents.length > 0}>
          <CompileLed />
        </Show>
      </div>
    </div>
  );
}
