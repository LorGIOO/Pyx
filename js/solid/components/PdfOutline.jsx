// Bookmarks of the PDF (TeXstudio's "Estructura del PDF", any PDF viewer's
// outline). The PDF's own outline when it has one (hyperref); otherwise the
// document's sections, each taken to its place in the PDF through SyncTeX —
// so it works for every document Pyx compiles.

import { createSignal, createEffect, For, Show } from 'solid-js';
import { t } from '../../core/i18n.js';
import { pdfOutline, goToOutline } from '../../pdf/preview.js';
import { hasPdf, previewFile } from '../stores/previewStore.js';
import { toc } from '../stores/structureStore.js';
import { forwardSearch } from '../../editor/commands.js';

function Tree(props) {
  return (
    <For each={props.items}>
      {(it) => (
        <>
          <div class="pdfo-row" style={{ 'padding-left': 8 + props.depth * 12 + 'px' }}
            title={it.title} onClick={() => goToOutline(it.dest)}>{it.title}</div>
          <Show when={it.items && it.items.length}>
            <Tree items={it.items} depth={props.depth + 1} />
          </Show>
        </>
      )}
    </For>
  );
}

export default function PdfOutline() {
  const [items, setItems] = createSignal([]);
  createEffect(() => {
    hasPdf(); previewFile(); // re-read when another PDF (or version) loads
    pdfOutline().then(setItems);
  });
  const minLevel = () => Math.min(...toc().map((h) => h.level), 9);
  return (
    <div class="pdfo">
      <div class="pdfo-title">{t('Marcadores', 'Bookmarks')}</div>
      <Show when={items().length} fallback={
        <Show when={toc().length} fallback={<div class="pdfo-empty">{t('El documento no tiene secciones.', 'The document has no sections.')}</div>}>
          <For each={toc()}>
            {(h) => (
              <div class="pdfo-row" style={{ 'padding-left': 8 + (h.level - minLevel()) * 12 + 'px' }}
                title={h.title} onClick={() => forwardSearch(h.line)}>{h.title}</div>
            )}
          </For>
        </Show>
      }>
        <Tree items={items()} depth={0} />
      </Show>
    </div>
  );
}
