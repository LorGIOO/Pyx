import { createSignal, onMount, onCleanup, Show, For } from 'solid-js';
import { state, activeDoc } from '../../core/state.js';
import { t } from '../../core/i18n.js';
import {
  isTauri,
  minimizeWindow,
  toggleMaximize,
  isMaximized,
  closeWindow,
  onWindowResized,
} from '../../core/platform.js';
import { doUndo, doRedo } from '../../editor/commands.js';
import { setShowConfig } from '../stores/settingsStore.js';
import { icons } from './ribbon/icons.js';
import { collab, inSession } from '../stores/collabStore.js';
import { openCollab, initials } from './CollabDialog.jsx';
import { FEATURES } from '../../core/features.js';
// Installs the drawn hover widget that replaces the native `title` tooltip,
// app-wide. Imported here because the title bar is always mounted.
import './Tooltip.jsx';

// Brand symbology (Simbología.svg, blue accent). The J-stroke follows the
// titlebar text color so it stays visible on light and dark themes; the bar
// and play triangle keep the brand blue.
const LOGO = `<svg viewBox="0 0 254 270" fill="none">
  <path d="M14 41.8675C14 38.0015 10.866 34.8675 7 34.8675C3.13401 34.8675 0 38.0015 0 41.8675V227.867C0 231.733 3.13401 234.867 7 234.867C10.866 234.867 14 231.733 14 227.867V41.8675Z" fill="#007ACC"/>
  <path d="M192 36.8675C192 16.8675 176 6.86753 160 10.8675C136 16.8675 132 40.8675 132 78.8675V190.868C132 228.868 128 252.868 104 258.868C88 262.868 72 252.868 72 232.868" stroke="var(--theme-titlebar-text)" stroke-width="20" stroke-linecap="round"/>
  <path d="M212 200.867V250.867L254 225.867L212 200.867Z" fill="#007ACC"/>
</svg>`;

export default function TitleBar() {
  const [maximized, setMaximized] = createSignal(false);
  let stop = () => {};

  onMount(async () => {
    if (!isTauri()) return;
    setMaximized(await isMaximized());
    stop = onWindowResized(async () => setMaximized(await isMaximized()));
  });
  onCleanup(() => stop());

  const fileName = () => {
    const d = activeDoc();
    if (!d) return '';
    return (d.modified ? '• ' : '') + d.fileName;
  };
  const hasDoc = () => state.documents.length > 0;

  const Qa = (props) => (
    <button class="quick-access-btn" title={props.title} disabled={props.disabled}
      onClick={props.onClick} innerHTML={props.icon}></button>
  );

  return (
    <div class="title-bar" data-tauri-drag-region>
      <div class="title-bar-left">
        <span class="app-icon" innerHTML={LOGO}></span>
        <div class="quick-access-toolbar">
          <Qa icon={icons.undo} title={t('Deshacer (Ctrl+Z)', 'Undo (Ctrl+Z)')} disabled={!hasDoc()} onClick={doUndo} />
          <Qa icon={icons.redo} title={t('Rehacer (Ctrl+Y)', 'Redo (Ctrl+Y)')} disabled={!hasDoc()} onClick={doRedo} />
          <div class="quick-access-separator"></div>
          <Qa icon={icons.gear} title={t('Configuración', 'Settings')} onClick={() => setShowConfig(true)} />
        </div>
      </div>

      <div class="title-bar-center">
        <span class="app-title">Pyx v{__APP_VERSION__}</span>
        <span class="file-name">{fileName()}</span>
      </div>

      <div class="window-controls">
        {/* Shared session: who is here (click a face to follow that person)
            and the «Compartir» button, Google Docs style. */}
        <Show when={FEATURES.collab}>
        <div class="collab-bar">
          <Show when={inSession()}>
            <div class="collab-faces">
              <For each={collab.members.filter((m) => m.online !== false).slice(0, 6)}>
                {(m) => (
                  <button class="collab-face" classList={{ following: collab.follow === m.mid, me: collab.me && collab.me.mid === m.mid }}
                    style={{ background: m.color }}
                    title={collab.me && collab.me.mid === m.mid ? `${m.name} (tú)` : collab.follow === m.mid ? `Siguiendo a ${m.name} — clic para dejar de seguir` : `${m.name} — clic para seguirle`}
                    onClick={() => {
                      if (collab.me && collab.me.mid === m.mid) return;
                      import('../../collab/presence-tracker.js').then((t) => t.followPerson(collab.follow === m.mid ? null : m.mid));
                    }}>{initials(m.name)}</button>
                )}
              </For>
            </div>
          </Show>
          <button class="collab-share" classList={{ live: inSession(), warn: collab.conn === 'reconnecting' || collab.conn === 'host-down' }}
            title={inSession() ? 'Sesión compartida' : 'Trabajar a la vez con otras personas'}
            onClick={() => openCollab()}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="6" cy="5.5" r="2.4" /><path d="M1.8 13.5c.5-2.4 2.2-3.8 4.2-3.8s3.7 1.4 4.2 3.8" /><circle cx="11.6" cy="6.2" r="1.9" /><path d="M11 9.8c1.7.1 2.9 1.3 3.3 3.2" /></svg>
            <span>{inSession() ? (collab.joins.length ? `${collab.joins.length} esperando` : 'En sesión') : 'Compartir'}</span>
          </button>
        </div>
        </Show>
        <Show when={isTauri()}>
          <button class="window-btn" title={t('Minimizar', 'Minimize')} onClick={() => minimizeWindow()}>
            <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg>
          </button>
          <button class="window-btn" title={maximized() ? t('Restaurar', 'Restore') : t('Maximizar', 'Maximize')} onClick={() => toggleMaximize()}>
            <Show
              when={maximized()}
              fallback={<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>}
            >
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2">
                <rect x="3" y="1.5" width="7" height="7" /><rect x="1.5" y="3" width="7" height="7" fill="var(--theme-titlebar-bg-start)" />
              </svg>
            </Show>
          </button>
          <button class="window-btn window-btn-close" title={t('Cerrar', 'Close')} onClick={() => closeWindow()}>
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" stroke-width="1.2" /><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" stroke-width="1.2" /></svg>
          </button>
        </Show>
      </div>
    </div>
  );
}
