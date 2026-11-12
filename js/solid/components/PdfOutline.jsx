// Bookmarks of the PDF (TeXstudio's "Estructura del PDF", any PDF viewer's
// outline). The PDF's own outline when it has one (hyperref); otherwise the
// document's sections, each taken to its place in the PDF through SyncTeX —
// so it works for every document Pyx compiles.

import { createSignal, createEffect, createMemo, For, Show } from 'solid-js';
import { t } from '../../core/i18n.js';
import { pdfOutline, goToOutline } from '../../pdf/preview.js';
import { hasPdf, pdfVersion, currentPage } from '../stores/previewStore.js';
import { toc } from '../stores/structureStore.js';
import { forwardSearch } from '../../editor/commands.js';

// Branches the user folded, by title path: kept across recompiles, which
// rebuild the whole tree (same titles, new objects).
const [folded, setFolded] = createSignal(new Set());
const toggleFold = (key) => {
  const next = new Set(folded());
  if (next.has(key)) next.delete(key); else next.add(key);
  setFolded(next);
};

function Tree(props) {
  return (
    <For each={props.items}>
      {(it, i) => {
        const key = `${props.path}/${i()}:${it.title}`;
        const kids = () => it.items && it.items.length > 0;
        return (
          <>
            <div class="pdfo-row" classList={{ current: props.current() === it, dead: !it.page }}
              style={{ 'padding-left': 4 + props.depth * 12 + 'px' }}
              title={it.page ? `${it.title} — ${t('página', 'page')} ${it.page}` : it.title}
              onClick={() => goToOutline(it)}>
              {/* The twisty folds the branch; a click anywhere else on the row
                  goes to the bookmark. */}
              <span class="pdfo-twisty" classList={{ leaf: !kids() }}
                onClick={(e) => { if (kids()) { e.stopPropagation(); toggleFold(key); } }}>
                {kids() ? (folded().has(key) ? '▸' : '▾') : ''}
              </span>
              <span class="pdfo-text">{it.title}</span>
              <Show when={it.page}><span class="pdfo-page">{it.page}</span></Show>
            </div>
            <Show when={kids() && !folded().has(key)}>
              <Tree items={it.items} depth={props.depth + 1} path={key} current={props.current} />
            </Show>
          </>
        );
      }}
    </For>
  );
}

export default function PdfOutline() {
  const [items, setItems] = createSignal([]);
  let asked = 0;
  createEffect(() => {
    hasPdf();
    // EVERY load, not every file name: a recompile keeps the name, and the
    // outline read from the previous version pointed into a PDF that no
    // longer exists (a click then went to the wrong page, or nowhere).
    pdfVersion();
    const mine = ++asked;
    pdfOutline().then((list) => { if (mine === asked) setItems(list); });
  });
  // The bookmark you are reading: the last one at or before the page in view.
  const current = createMemo(() => {
    const page = currentPage();
    let best = null;
    const walk = (list) => {
      for (const it of list) {
        if (it.page && it.page <= page && (!best || it.page >= best.page)) best = it;
        if (it.items) walk(it.items);
      }
    };
    walk(items());
    return best;
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
                title={h.title} onClick={() => forwardSearch(h.line)}>
                <span class="pdfo-text">{h.title}</span>
              </div>
            )}
          </For>
        </Show>
      }>
        <Tree items={items()} depth={0} path="" current={current} />
      </Show>
    </div>
  );
}
