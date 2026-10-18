// "Historial": the saved versions of the active document (every save keeps
// one — history.rs) and, when the project is a Git repository, its changes,
// a box to commit them and the recent log.
//
// A version opens as a comparison with the current text (lines removed in
// red, added in green); "Restaurar" puts it back in the editor — undoable
// with Ctrl+Z, saved when you save.

import { createSignal, createEffect, on, For, Show } from 'solid-js';
import { state, activeDoc } from '../../core/state.js';
import { t } from '../../core/i18n.js';
import { dirOf } from '../../core/paths.js';
import {
  historyList, historyRead, gitStatus, gitInit, gitCommit, gitShow, isTauri,
} from '../../core/platform.js';
import { getDocContent, getViewOfDoc } from '../../editor/setup.js';
import { diffLines, hunks } from '../../editor/line-diff.js';

const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return t('hace un momento', 'just now');
  if (s < 3600) return t(`hace ${Math.round(s / 60)} min`, `${Math.round(s / 60)} min ago`);
  if (s < 86400) return t(`hace ${Math.round(s / 3600)} h`, `${Math.round(s / 3600)} h ago`);
  return new Date(ms).toLocaleString();
};

async function projectDir() {
  try {
    const m = await import('../../compile/compiler.js');
    const r = await m.activeRootDir();
    if (r) return r;
  } catch (_) { /* fall through */ }
  const d = activeDoc();
  return d && d.path ? dirOf(d.path) : null;
}

export default function HistoryPanel() {
  const [versions, setVersions] = createSignal([]);
  const [compare, setCompare] = createSignal(null); // {label, old, rows}
  const [git, setGit] = createSignal(null);
  const [dir, setDir] = createSignal(null);
  const [msg, setMsg] = createSignal('');
  const [note, setNote] = createSignal('');

  const refresh = async () => {
    const d = activeDoc();
    if (!d || !d.path || !isTauri()) { setVersions([]); setGit(null); return; }
    setVersions(await historyList(d.path).catch(() => []));
    const pd = await projectDir();
    setDir(pd);
    setGit(pd ? await gitStatus(pd).catch(() => null) : null);
  };
  createEffect(on(() => [state.activeIndex, activeDoc() && activeDoc().modified], refresh));

  const open = async (label, oldText) => {
    const d = activeDoc();
    const cur = d ? getDocContent(d.id) || '' : '';
    setCompare({ label, old: oldText, rows: hunks(diffLines(oldText, cur), 2) });
  };
  const openVersion = async (v) => open(ago(v.id), await historyRead(activeDoc().path, v.id).catch(() => ''));
  const openCommit = async (hash) => {
    try { open(`commit ${hash}`, await gitShow(dir(), hash, activeDoc().path)); } catch (e) { setNote(String(e)); }
  };
  const restore = () => {
    const c = compare();
    const d = activeDoc();
    const v = d ? getViewOfDoc(d.id) : null;
    if (!c || !v) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: c.old } });
    setCompare(null);
  };
  const commit = async () => {
    try {
      await gitCommit(dir(), msg());
      setMsg(''); setNote(t('Cambios confirmados.', 'Changes committed.'));
    } catch (e) { setNote(String((e && e.message) || e)); }
    refresh();
  };

  return (
    <div class="hist">
      <Show when={compare()}>
        <div class="hist-compare">
          <div class="hist-compare-bar">
            <b>{compare().label}</b>
            <span style={{ flex: 1 }} />
            <button class="hist-btn" onClick={restore} title={t('Poner esta versión en el editor (Ctrl+Z la deshace)', 'Put this version in the editor (Ctrl+Z undoes it)')}>{t('Restaurar', 'Restore')}</button>
            <button class="hist-btn" onClick={() => setCompare(null)}>✕</button>
          </div>
          <div class="hist-diff">
            <Show when={compare().rows.some((r) => r.type === '-' || r.type === '+')} fallback={<div class="side-empty">{t('Igual que el texto actual.', 'Same as the current text.')}</div>}>
              <For each={compare().rows}>
                {(r) => <div class={`hist-line t${r.type === '…' ? 'gap' : r.type === '-' ? 'del' : r.type === '+' ? 'add' : 'same'}`}>{r.type === '…' ? '⋯' : `${r.type} ${r.text}`}</div>}
              </For>
            </Show>
          </div>
        </div>
      </Show>

      <div class="sym-cat-name">{t('Versiones guardadas', 'Saved versions')}</div>
      <Show when={versions().length} fallback={<div class="side-empty">{activeDoc() && activeDoc().path ? t('Cada vez que guardes, se conservará aquí una versión.', 'Every time you save, a version is kept here.') : t('Guarda el documento para empezar su historial.', 'Save the document to start its history.')}</div>}>
        <For each={versions()}>
          {(v) => (
            <div class="hist-row" onClick={() => openVersion(v)} title={new Date(v.id).toLocaleString()}>
              <span>{ago(v.id)}</span><span class="hist-size">{(v.size / 1024).toFixed(1)} KB</span>
            </div>
          )}
        </For>
      </Show>

      <Show when={git() && git().installed}>
        <div class="sym-cat-name" style={{ 'margin-top': '10px' }}>Git</div>
        <Show when={git().repo} fallback={
          <div class="hist-git">
            <div class="side-empty">{t('La carpeta del proyecto no es un repositorio.', 'The project folder is not a repository.')}</div>
            <button class="hist-btn" onClick={async () => { await gitInit(dir()).catch((e) => setNote(String(e))); refresh(); }}>{t('Crear repositorio', 'Create repository')}</button>
          </div>
        }>
          <div class="hist-git">
            <div class="hist-branch">⎇ {git().branch} · {git().changes.length} {t('cambios', 'changes')}</div>
            <Show when={git().changes.length}>
              <div class="hist-changes">
                <For each={git().changes.slice(0, 30)}>{(c) => <div class="hist-change">{c}</div>}</For>
              </div>
              <textarea class="hist-msg" rows="2" placeholder={t('Describe los cambios…', 'Describe the changes…')}
                value={msg()} onInput={(e) => setMsg(e.currentTarget.value)} />
              <button class="hist-btn primary" disabled={!msg().trim()} onClick={commit}>{t('Confirmar todo (commit)', 'Commit all')}</button>
            </Show>
            <For each={git().log}>
              {(l) => {
                const [hash, date, author, subject] = l.split('\x1f');
                return (
                  <div class="hist-row" onClick={() => openCommit(hash)} title={`${hash} · ${author}`}>
                    <span class="hist-subject">{subject}</span><span class="hist-size">{date}</span>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>
      <Show when={note()}><div class="hist-note">{note()}</div></Show>
    </div>
  );
}
