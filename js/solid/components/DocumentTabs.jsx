import { For, createEffect, onCleanup } from 'solid-js';
import { state } from '../../core/state.js';
import { t } from '../../core/i18n.js';
import { switchTo, closeDocument } from '../stores/docStore.js';
import { openNewDoc } from './NewDocDialog.jsx';
import { icons } from './ribbon/icons.js';

const DOC_MIME = 'application/x-calc-doc';

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
            onClick={() => switchTo(i())}
            title={doc.path || doc.fileName}
            draggable={true}
            onDragStart={(e) => {
              // Drag a tab onto an editor pane (VSCode-style): drop on the
              // middle = open there, drop on the right edge = split.
              e.dataTransfer.setData(DOC_MIME, String(doc.id));
              e.dataTransfer.effectAllowed = 'move';
            }}
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
    </div>
  );
}
