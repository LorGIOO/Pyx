import { For } from 'solid-js';
import { state } from '../../core/state.js';
import { t } from '../../core/i18n.js';
import { switchTo, closeDocument } from '../stores/docStore.js';
import { openNewDoc } from './NewDocDialog.jsx';

const DOC_MIME = 'application/x-calc-doc';

export default function DocumentTabs() {
  return (
    <div class="document-tabs">
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
            <button
              class="doc-tab-close"
              title={t('Cerrar', 'Close')}
              onClick={(e) => {
                e.stopPropagation();
                closeDocument(i());
              }}
            >
              ×
            </button>
          </div>
        )}
      </For>
      <button class="doc-tab-add" title={t('Nuevo documento (Ctrl+N)', 'New document (Ctrl+N)')} onClick={openNewDoc}>
        +
      </button>
    </div>
  );
}
