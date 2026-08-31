// Minimal VSCode-style search panel for CodeMirror: a compact floating box
// with the input, match counter, prev/next/close, icon toggles (Aa, .*) and an
// expandable replace row — replacing CM's default (busy) search bar.

import {
  SearchQuery, setSearchQuery, getSearchQuery,
  findNext, findPrevious, replaceNext, replaceAll, closeSearchPanel,
} from '@codemirror/search';

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

  const expand = btn('▸', 'Reemplazar', () => {
    showReplace = !showReplace;
    expand.textContent = showReplace ? '▾' : '▸';
    row2.style.display = showReplace ? 'flex' : 'none';
  });
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
  function updateCount() {
    const q = currentQuery();
    if (!q.search) { count.textContent = ''; return; }
    let n = 0;
    try {
      const cur = q.getCursor(view.state);
      while (!cur.next().done && n < 1000) n++;
    } catch (_) { /* bad regex while typing */ }
    count.textContent = n >= 1000 ? '999+' : `${n} resultados`;
  }

  return {
    dom,
    top: true,
    mount() {
      const q = getSearchQuery(view.state);
      if (q && q.search) input.value = q.search;
      input.focus();
      input.select();
      updateCount();
    },
    update(u) {
      if (u.docChanged) updateCount();
    },
  };
}
