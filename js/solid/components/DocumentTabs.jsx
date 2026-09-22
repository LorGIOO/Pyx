import { For } from 'solid-js';
import { state } from '../../core/state.js';
import { t } from '../../core/i18n.js';
import { switchTo, closeDocument } from '../stores/docStore.js';
import { openNewDoc } from './NewDocDialog.jsx';
import { icons } from './ribbon/icons.js';

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
      <button class="doc-tab-add pyx-ico" title={t('Nuevo documento (Ctrl+N)', 'New document (Ctrl+N)')}
        innerHTML={icons.add} onClick={openNewDoc} />
    </div>
  );
}
