// "Buscar en el proyecto" (Ctrl+Mayús+F): every match in every file of the
// project, grouped by file; a click opens the file on the match. Open
// documents are searched as they are in the editor, unsaved changes included.
// Replace changes the open documents in the editor (undoable, saved when you
// save) and writes the closed text files directly, after asking.

import { createSignal, For, Show, onMount } from 'solid-js';
import { state } from '../../core/state.js';
import { t } from '../../core/i18n.js';
import { dirOf, relativeTo, samePath } from '../../core/paths.js';
import {
  projectTexts, readBinaryFile, writeBinaryFile, isTauri, askDialog, messageDialog,
} from '../../core/platform.js';
import { getDocContent, getViewOfDoc, applyDocChanges } from '../../editor/setup.js';
import {
  searchTexts, replaceEdits, replaceInBytes, queryRegExp,
} from '../../editor/project-search.js';
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
    // relativeTo answers null for a path outside the root — an open document
    // of another project. Calling a method on that null threw, the search
    // never finished and the panel stayed on «Buscando…».
    const inRoot = !root || (d.path && relativeTo(root, d.path) !== null);
    if (d.path && !inRoot) continue;
    // The file the walk already found, under ITS spelling of the path: the
    // editor's text replaces the disk's, instead of listing the file twice.
    const onDisk = d.path && disk.find((f) => samePath(f.path, d.path));
    const key = onDisk ? onDisk.path : (d.path || `(sin guardar) ${d.fileName || ''}`);
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

  let runSeq = 0;
  const run = async () => {
    const q = query();
    const seq = ++runSeq;
    if (!q) { setResult(null); setBusy(false); return; }
    setBusy(true);
    try {
      const r = await projectRoot();
      const files = await gatherTexts(r);
      // A newer search started while this one read the disk: its answer wins.
      if (seq !== runSeq) return;
      setRoot(r);
      setResult({ ...searchTexts(files, q, opts()), allFiles: files });
    } catch (_) {
      if (seq === runSeq) setResult({ files: [], total: 0, capped: false, allFiles: [] });
    } finally {
      // Whatever happened, the panel must not stay on «Buscando…».
      if (seq === runSeq) setBusy(false);
    }
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
    const n = `${res.total}${res.capped ? '+' : ''}`, f = res.files.length;
    // The platform's own dialog: `window.confirm` is suppressed in some
    // WebView2 configurations, where it answers false without showing
    // anything — «Reemplazar todo» then did nothing and said nothing.
    const ok = await askDialog(t(`¿Reemplazar ${n} coincidencia${res.total === 1 ? '' : 's'} en ${f} archivo${f === 1 ? '' : 's'}?\n\nLos documentos abiertos se cambian en el editor (Ctrl+Z para deshacer); los demás archivos de texto se guardan directamente.`,
      `Replace ${n} match${res.total === 1 ? '' : 'es'} in ${f} file${f === 1 ? '' : 's'}?\n\nOpen documents change in the editor (Ctrl+Z to undo); other text files are written directly.`),
    { title: t('Reemplazar en el proyecto', 'Replace in project'), okLabel: t('Reemplazar', 'Replace'), cancelLabel: t('Cancelar', 'Cancel') }).catch(() => false);
    if (!ok) return;
    setBusy(true);
    const q = query(), rep = replace(), o = opts();
    const skipped = [];
    // In the editor, as individual edits (not the whole text swapped): undo
    // steps back through real changes and the cursor stays where it was. It
    // works on a document in a background tab too — that one has no view, and
    // used to be changed on disk behind its tab, which then held the old text
    // and put it back on the next Ctrl+S.
    const inEditor = (d) => {
      const edits = replaceEdits(getDocContent(d.id), q, rep, o);
      return !edits.length || applyDocChanges(d.id, edits);
    };
    try {
      for (const hit of res.files) {
        const d = state.documents.find((x) => !x.kind && (samePath(x.path, hit.path) || `(sin guardar) ${x.fileName || ''}` === hit.path));
        if (d) {
          if (!inEditor(d)) skipped.push(hit.path);
          continue;
        }
        if (/\.pltx$/i.test(hit.path)) {
          // A closed .pltx is a container: open it and replace in the editor.
          await openPath(hit.path);
          const d2 = state.documents.find((x) => !x.kind && samePath(x.path, hit.path));
          if (!d2 || !inEditor(d2)) skipped.push(hit.path);
          continue;
        }
        // A closed text file: on its own bytes, read NOW (not the text the
        // search took a while ago), and written back in its own encoding.
        try {
          const out = replaceInBytes(await readBinaryFile(hit.path), q, rep, o);
          if (out.unmappable.length) {
            skipped.push(`${hit.path}  (${t('su codificación no admite', 'its encoding cannot hold')} ${out.unmappable.slice(0, 6).join(' ')})`);
          } else if (out.count) await writeBinaryFile(hit.path, out.bytes);
        } catch (_) { skipped.push(hit.path); }
      }
    } finally {
      setBusy(false);
    }
    if (skipped.length) {
      await messageDialog(t(`No se pudieron cambiar:\n\n${skipped.join('\n')}`, `Could not change:\n\n${skipped.join('\n')}`),
        { title: t('Reemplazar en el proyecto', 'Replace in project'), kind: 'warning' }).catch(() => {});
    }
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
