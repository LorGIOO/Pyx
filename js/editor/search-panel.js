// Minimal VSCode-style search panel for CodeMirror: a compact floating box
// with the input, match counter, prev/next/close, icon toggles (Aa, .*) and an
// expandable replace row — replacing CM's default (busy) search bar.

import {
  SearchQuery, setSearchQuery, getSearchQuery,
  findNext, findPrevious, replaceNext, replaceAll, closeSearchPanel, openSearchPanel,
} from '@codemirror/search';

/* Opening the panel FOR something: "Buscar" (Ctrl+F) or "Reemplazar" (Ctrl+R).
 *
 * The panel is created once per editor and then only focused, so what the
 * caller wants — the replace row open, the selected word as the search — has
 * to reach a panel that may already exist. `panels` keeps each live panel's
 * `apply`; `pending` carries the request across the creation of a new one. */
const panels = new WeakMap(); // EditorView -> { apply }
let pending = null;

/** Open (or re-focus) the search panel. With `replace`, the replace row is
 *  shown; a word or phrase selected in the editor (one line) becomes the
 *  search, every match of it is highlighted, and the caret lands in
 *  "Reemplazar" ready for the new text. */
export function openSearch(view, { replace = false } = {}) {
  const sel = view.state.selection.main;
  const text = sel.empty || sel.to - sel.from > 300 ? '' : view.state.sliceDoc(sel.from, sel.to);
  pending = { replace, seed: text.includes('\n') ? '' : text };
  openSearchPanel(view); // mounts a new panel (which takes `pending`) or focuses the open one
  const api = panels.get(view);
  if (api && pending) api.apply(pending);
  pending = null;
}

export function pyxSearchPanel(view) {
  let caseSensitive = false, regexp = false, whole = false, showReplace = false;

  const dom = document.createElement('div');
  dom.className = 'pyx-search';
  dom.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSearchPanel(view); view.focus(); }
  };

  /* row 1: search */
  const row1 = document.createElement('div');
  row1.className = 'ps-row';

  const expand = btn('▸', 'Reemplazar (Ctrl+R)', () => setReplaceRow(!showReplace));
  expand.classList.add('ps-expand');

  const input = document.createElement('input');
  input.className = 'ps-input';
  input.placeholder = 'Buscar';
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); findNext(view); }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); findPrevious(view); }
  };
  input.oninput = () => push();

  const count = document.createElement('span');
  count.className = 'ps-count';

  const tCase = toggle('Aa', 'Distinguir mayúsculas', () => { caseSensitive = !caseSensitive; push(); });
  const tRe = toggle('.*', 'Expresión regular', () => { regexp = !regexp; push(); });
  const tWord = toggle('ab', 'Palabra completa', () => { whole = !whole; push(); });

  row1.append(
    expand, input, count, tCase, tRe, tWord,
    btn('↑', 'Anterior (Shift+Enter)', () => findPrevious(view)),
    btn('↓', 'Siguiente (Enter)', () => findNext(view)),
    btn('✕', 'Cerrar (Esc)', () => { closeSearchPanel(view); view.focus(); }),
  );

  /* row 2: replace (hidden until expanded) */
  const row2 = document.createElement('div');
  row2.className = 'ps-row';
  row2.style.display = 'none';
  const rinput = document.createElement('input');
  rinput.className = 'ps-input';
  rinput.placeholder = 'Reemplazar';
  rinput.oninput = () => push();
  rinput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); replaceNext(view); } };
  row2.append(
    rinput,
    btn('⇄', 'Reemplazar', () => replaceNext(view)),
    btn('⇄∗', 'Reemplazar todo', () => replaceAll(view)),
  );

  dom.append(row1, row2);

  function btn(text, title, onClick) {
    const b = document.createElement('button');
    b.className = 'ps-btn';
    b.textContent = text;
    b.title = title;
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = onClick;
    return b;
  }
  function toggle(text, title, onChange) {
    const b = btn(text, title, () => { b.classList.toggle('on'); onChange(); });
    b.classList.add('ps-toggle');
    return b;
  }

  function currentQuery() {
    return new SearchQuery({
      search: input.value,
      replace: rinput.value,
      caseSensitive,
      regexp,
      wholeWord: whole,
    });
  }
  function push() {
    view.dispatch({ effects: setSearchQuery.of(currentQuery()) });
    updateCount();
  }
  let countTimer = 0;
  function updateCount() {
    clearTimeout(countTimer);
    const q = currentQuery();
    if (!q.search) { count.textContent = ''; return; }
    let n = 0;
    try {
      const cur = q.getCursor(view.state);
      while (!cur.next().done && n < 1000) n++;
    } catch (_) { /* bad regex while typing */ }
    count.textContent = n >= 1000 ? '999+' : `${n} resultados`;
  }

  function setReplaceRow(on) {
    showReplace = on;
    expand.textContent = on ? '▾' : '▸';
    row2.style.display = on ? 'flex' : 'none';
  }
  function apply(req) {
    if (req.seed) { input.value = req.seed; push(); }
    if (req.replace) {
      setReplaceRow(true);
      // With the word to replace already chosen, the next thing typed is
      // its replacement; with nothing selected, the search comes first.
      const target = input.value ? rinput : input;
      target.focus();
      target.select();
    } else {
      input.focus();
      input.select();
    }
  }

  return {
    dom,
    top: true,
    mount() {
      const q = getSearchQuery(view.state);
      if (q && q.search) input.value = q.search;
      panels.set(view, { apply });
      if (pending) { apply(pending); pending = null; } else { input.focus(); input.select(); }
      updateCount();
    },
    update(u) {
      // Not on the key press itself: counting walks up to 1000 matches from
      // the top of the document, and with the panel open that ran on every
      // character typed. Once, when typing pauses, is all the counter needs.
      if (!u.docChanged) return;
      clearTimeout(countTimer);
      countTimer = setTimeout(updateCount, 200);
    },
    destroy() { clearTimeout(countTimer); panels.delete(view); },
  };
}
