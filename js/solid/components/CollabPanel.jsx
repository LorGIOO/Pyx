import { For, Show, createMemo } from 'solid-js';
import { state, activeDoc } from '../../core/state.js';
import { collab, inSession } from '../stores/collabStore.js';
import { MemberList, openCollab, connText } from './CollabDialog.jsx';
import { permLabel } from '../../collab/permissions.js';

// Side panel «Sesión compartida»: who is in and where, follow someone, and
// (guests) the project's files to open.

export default function CollabPanel() {
  const current = createMemo(() => {
    const d = activeDoc();
    return d && d.remote ? d.remote.path : null;
  });
  const open = (rel) => import('../../collab/app.js').then((a) => a.openSharedFile(rel));
  return (
    <div class="collab-panel">
      <Show when={inSession()} fallback={
        <div class="side-empty">
          <p>Edita el mismo proyecto a la vez que otras personas, viendo dónde está cada una.</p>
          <button class="ctl-btn primary" onClick={() => openCollab('share')}>Compartir…</button>
          <button class="ctl-btn" style={{ 'margin-left': '6px' }} onClick={() => openCollab('join')}>Unirme…</button>
        </div>
      }>
        <div class="collab-panel-head">
          <span>{collab.role === 'host' ? 'Compartiendo' : `Invitado · ${permLabel(collab.perms)}`}</span>
          <button class="ctl-btn small" onClick={() => openCollab()}>Gestionar</button>
        </div>
        <div class="collab-conn small">{connText()}</div>
        <MemberList follow />
        <Show when={collab.files.length}>
          <div class="sym-cat-name" style={{ 'margin-top': '10px' }}>Archivos del proyecto</div>
          <div class="collab-files">
            <For each={collab.files}>
              {(f) => (
                <div class="collab-file" classList={{ active: current() === f.path, main: collab.main === f.path }}
                  title={f.path} onClick={() => open(f.path)}>
                  {f.path}
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}

void state;
