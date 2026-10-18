// "Buscar en el proyecto" (Ctrl+Mayús+F): every match in every file of the
// project, grouped by file; a click opens the file on the match. Open
// documents are searched as they are in the editor, unsaved changes included.
// Replace changes the open documents in the editor (undoable, saved when you
// save) and writes the closed text files directly, after asking.

import { createSignal, For, Show, onMount } from 'solid-js';
import { state } from '../../core/state.js';
import { t } from '../../core/i18n.js';
import { dirOf, relativeTo, samePath } from '../../core/paths.js';
import { projectTexts, writeTextFile, isTauri } from '../../core/platform.js';
import { getDocContent, getViewOfDoc } from '../../editor/setup.js';
import { searchTexts, replaceInText, queryRegExp } from '../../editor/project-search.js';
import { openPath } from '../stores/docStore.js';

async function projectRoot() {
  try {
    const m = await import('../../compile/compiler.js');
    const r = await m.activeRootDir();
    if (r) return r;
  } catch (_) { /* fall through */ }
  const d = state.documents[state.activeIndex];
  return d && d.path ? dirOf(d.path) : null;
}

/** Project files, with the open documents' editor text taking precedence. */
async function gatherTexts(root) {
  const disk = isTauri() && root ? await projectTexts(root).catch(() => []) : [];
  const files = new Map(disk.map((f) => [f.path, f]));
  for (const d of state.documents) {
    if (d.kind) continue;
    // No project folder (an unsaved document): the open documents are the project.
    const inRoot = !root || (d.path && (samePath(dirOf(d.path), root) || relativeTo(root, d.path).indexOf('..') !== 0));
    if (d.path && !inRoot) continue;
    const key = d.path || `(sin guardar) ${d.fileName || ''}`;
    let text = '';
    try { text = getDocContent(d.id) || ''; } catch (_) { continue; }
    files.set(key, { path: key, text, docId: d.id });
  }
  return [...files.values()];
}

export default function ProjectSearch() {
  const [query, setQuery] = createSignal('');
  const [replace, setReplace] = createSignal('');
  const [showReplace, setShowReplace] = createSignal(false);
  const [opts, setOpts] = createSignal({ caseSensitive: false, regexp: false, whole: false });
  const [result, setResult] = createSignal(null);
  const [busy, setBusy] = createSignal(false);
  const [root, setRoot] = createSignal(null);
  const [collapsed, setCollapsed] = createSignal(new Set());
  let input;
  let timer = 0;

  const run = async () => {
    const q = query();
    if (!q) { setResult(null); return; }
    setBusy(true);
    const r = await projectRoot();
    setRoot(r);
    const files = await gatherTexts(r);
    setResult({ ...searchTexts(files, q, opts()), allFiles: files });
    setBusy(false);
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 250); };
  const flip = (k) => { setOpts({ ...opts(), [k]: !opts()[k] }); schedule(); };

  onMount(() => {
    // Seed with the editor's selection, like VS Code.
    const d = state.documents[state.activeIndex];
    const v = d ? getViewOfDoc(d.id) : null;
    if (v) {
      const s = v.state.selection.main;
      const sel = v.state.sliceDoc(s.from, s.to);
      if (sel && !sel.includes('\n') && sel.length < 200) { setQuery(sel); run(); }
    }
    setTimeout(() => input && input.focus(), 0);
  });

  const label = (path) => {
    const r = root();
    return r && !path.startsWith('(') ? relativeTo(r, path) : path;
  };

  const goTo = async (file, m) => {
    await openPath(file.path.startsWith('(') ? null : file.path);
    const d = state.documents.find((x) => (file.docId != null ? x.id === file.docId : samePath(x.path, file.path)));
    const v = d ? getViewOfDoc(d.id) : null;
    if (!v) return;
    const line = v.state.doc.line(Math.min(m.line, v.state.doc.lines));
    const from = Math.min(line.from + m.col, line.to);
    v.dispatch({ selection: { anchor: from, head: Math.min(from + m.len, line.to) }, scrollIntoView: true });
    v.focus();
  };

  const replaceAll = async () => {
    const res = result();
    if (!res || !res.total) return;
    const n = res.total, f = res.files.length;
    if (!window.confirm(t(`¿Reemplazar ${n} coincidencia${n === 1 ? '' : 's'} en ${f} archivo${f === 1 ? '' : 's'}?\n\nLos documentos abiertos se cambian en el editor (Ctrl+Z para deshacer); los demás archivos de texto se guardan directamente.`,
      `Replace ${n} match${n === 1 ? '' : 'es'} in ${f} file${f === 1 ? '' : 's'}?\n\nOpen documents change in the editor (Ctrl+Z to undo); other text files are written directly.`))) return;
    setBusy(true);
    const skipped = [];
    for (const hit of res.files) {
      const d = state.documents.find((x) => !x.kind && (samePath(x.path, hit.path) || `(sin guardar) ${x.fileName || ''}` === hit.path));
      const v = d ? getViewOfDoc(d.id) : null;
      if (v) {
        const { text, count } = replaceInText(v.state.doc.toString(), query(), replace(), opts());
        if (count) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
        continue;
      }
      if (/\.pltx$/i.test(hit.path)) {
        // A closed .pltx is a container: open it and replace in the editor.
        await openPath(hit.path);
        const d2 = state.documents.find((x) => samePath(x.path, hit.path));
        const v2 = d2 ? getViewOfDoc(d2.id) : null;
        if (v2) {
          const { text, count } = replaceInText(v2.state.doc.toString(), query(), replace(), opts());
          if (count) v2.dispatch({ changes: { from: 0, to: v2.state.doc.length, insert: text } });
        } else skipped.push(hit.path);
        continue;
      }
      const disk = res.allFiles.find((x) => x.path === hit.path);
      if (!disk) { skipped.push(hit.path); continue; }
      const { text, count } = replaceInText(disk.text, query(), replace(), opts());
      if (count) {
        try { await writeTextFile(hit.path, text); } catch (_) { skipped.push(hit.path); }
      }
    }
    setBusy(false);
    if (skipped.length) window.alert(t(`No se pudieron cambiar:\n${skipped.join('\n')}`, `Could not change:\n${skipped.join('\n')}`));
    run();
  };

  const toggleFile = (path) => {
    const s = new Set(collapsed());
    if (s.has(path)) s.delete(path); else s.add(path);
    setCollapsed(s);
  };

  const invalid = () => query() && opts().regexp && !queryRegExp(query(), opts());

  return (
    <div class="psearch">
      <div class="psearch-row">
        <button class="psearch-exp" title={t('Reemplazar', 'Replace')} onClick={() => setShowReplace(!showReplace())}>
          {showReplace() ? '▾' : '▸'}
        </button>
        <input ref={input} class="psearch-input" classList={{ invalid: !!invalid() }} type="search"
          placeholder={t('Buscar en el proyecto', 'Search the project')} value={query()}
          onInput={(e) => { setQuery(e.currentTarget.value); schedule(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } }} />
        <button class="psearch-tog" classList={{ on: opts().caseSensitive }} title={t('Distinguir mayúsculas', 'Match case')} onClick={() => flip('caseSensitive')}>Aa</button>
        <button class="psearch-tog" classList={{ on: opts().whole }} title={t('Palabra completa', 'Whole word')} onClick={() => flip('whole')}>ab</button>
        <button class="psearch-tog" classList={{ on: opts().regexp }} title={t('Expresión regular', 'Regular expression')} onClick={() => flip('regexp')}>.*</button>
      </div>
      <Show when={showReplace()}>
        <div class="psearch-row">
          <span class="psearch-exp" />
          <input class="psearch-input" type="text" placeholder={t('Reemplazar por', 'Replace with')}
            value={replace()} onInput={(e) => setReplace(e.currentTarget.value)} />
          <button class="psearch-btn" disabled={busy() || !result() || !result().total} onClick={replaceAll}
            title={t('Reemplazar todo', 'Replace all')}>{t('Todo', 'All')}</button>
        </div>
      </Show>
      <div class="psearch-summary">
        <Show when={busy()} fallback={
          <Show when={result()}>
            {result().total
              ? t(`${result().total}${result().capped ? '+' : ''} resultados en ${result().files.length} archivo${result().files.length === 1 ? '' : 's'}`,
                `${result().total}${result().capped ? '+' : ''} results in ${result().files.length} file${result().files.length === 1 ? '' : 's'}`)
              : t('Sin resultados.', 'No results.')}
          </Show>
        }>{t('Buscando…', 'Searching…')}</Show>
      </div>
      <div class="psearch-list">
        <For each={result() ? result().files : []}>
          {(f) => (
            <div class="psearch-file">
              <div class="psearch-fname" onClick={() => toggleFile(f.path)} title={f.path}>
                <span class="psearch-caret">{collapsed().has(f.path) ? '▸' : '▾'}</span>
                <span class="psearch-name">{label(f.path)}</span>
                <span class="psearch-count">{f.matches.length}</span>
              </div>
              <Show when={!collapsed().has(f.path)}>
                <For each={f.matches.slice(0, 500)}>
                  {(m) => {
                    const start = Math.max(0, m.col - 30);
                    return (
                      <div class="psearch-hit" onClick={() => goTo({ ...f, docId: (result().allFiles.find((x) => x.path === f.path) || {}).docId }, m)}
                        title={t(`Línea ${m.line}`, `Line ${m.line}`)}>
                        <span class="psearch-ln">{m.line}</span>
                        <span class="psearch-text">
                          {(start ? '…' : '') + m.text.slice(start, m.col).trimStart()}
                          <mark>{m.text.slice(m.col, m.col + m.len)}</mark>
                          {m.text.slice(m.col + m.len, m.col + m.len + 80)}
                        </span>
                      </div>
                    );
                  }}
                </For>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
