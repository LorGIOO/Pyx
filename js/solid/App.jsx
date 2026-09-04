import { Show } from 'solid-js';
import { state } from '../core/state.js';
import TitleBar from './components/TitleBar.jsx';
import Ribbon from './components/ribbon/Ribbon.jsx';
import DocumentTabs from './components/DocumentTabs.jsx';
import EditorPane from './components/EditorPane.jsx';
import PreviewPane from './components/PreviewPane.jsx';
import SidePanel from './components/SidePanel.jsx';
import StatusBar from './components/StatusBar.jsx';
import ConfigDialog from './components/ConfigDialog.jsx';
import ContextMenu from './components/ContextMenu.jsx';
import Wizards from './components/Wizards.jsx';
import NewDocDialog, { openNewDoc } from './components/NewDocDialog.jsx';
import { t } from '../core/i18n.js';
import { openDocument } from './stores/docStore.js';

export default function App() {
  // Drag the divider to resize editor vs. preview.
  const startDividerDrag = (e) => {
    e.preventDefault();
    const content = e.currentTarget.parentElement;
    const move = (ev) => {
      const rect = content.getBoundingClientRect();
      let r = (ev.clientX - rect.left) / rect.width;
      r = Math.min(0.85, Math.max(0.15, r));
      state.editorRatio = r;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <>
      {/* Zen mode: ONLY the file tabs + editor + viewer remain — even the
          title bar and ribbon disappear (Esc or Ctrl+Alt+Z exits). */}
      <Show when={!state.zenMode}>
        <TitleBar />
        <div class="ribbon-container">
          <Ribbon />
        </div>
      </Show>
      <DocumentTabs />

      <div class="content">
        <Show
          when={state.documents.length > 0}
          fallback={
            <div class="placeholder">
              {/* The Pyx mark. Painted in currentColor so it follows the
                  theme, light and dark, instead of the fixed grey it ships
                  with as a standalone asset. */}
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 82 97" fill="none">
                <path d="M3.625 11.1508C5.42062 11.1508 6.75 12.3979 6.75 13.7914V82.8851C6.75 84.2786 5.42062 85.5258 3.625 85.5258C1.82938 85.5258 0.5 84.2786 0.5 82.8851V13.7914C0.5 12.3979 1.82938 11.1508 3.625 11.1508Z"
                  fill="currentColor" stroke="currentColor" />
                <path d="M67.2 16.9319C67.2 -1.9118 41.1 -1.9118 41.1 23.2132V73.4632C41.1 98.5882 15 98.5882 15 79.7444"
                  stroke="currentColor" stroke-width="7" stroke-linecap="round" />
                <path d="M80.0586 84.7689L58.5 95.2758V74.2621L80.0586 84.7689Z"
                  fill="currentColor" stroke="currentColor" />
              </svg>
              <h2>{t('No hay ningún documento abierto', 'No document open')}</h2>
              <p>{t('Crea un documento nuevo o abre un archivo .tex para empezar.', 'Create a new document or open a .tex file to start.')}</p>
              <div class="hint-keys">
                <span><kbd>Ctrl</kbd> + <kbd>N</kbd> {t('nuevo', 'new')}</span>
                <span><kbd>Ctrl</kbd> + <kbd>O</kbd> {t('abrir', 'open')}</span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button class="preview-header" style={{ padding: '6px 14px', cursor: 'default' }} onClick={openNewDoc}>
                  {t('Nuevo documento', 'New document')}
                </button>
                <button class="preview-header" style={{ padding: '6px 14px', cursor: 'default' }} onClick={() => openDocument()}>
                  {t('Abrir', 'Open')}
                </button>
              </div>
            </div>
          }
        >
          <Show when={!state.viewerMaximized}>
            <Show when={!state.sidePanelHidden && !state.zenMode}><SidePanel /></Show>
            <div
              class="editor-pane"
              style={{ 'flex-grow': state.previewVisible ? state.editorRatio : 1, 'flex-basis': 0 }}
            >
              <EditorPane />
            </div>
          </Show>
          <Show when={state.previewVisible && !state.viewerMaximized}>
            <div class="pane-divider" onPointerDown={startDividerDrag} />
          </Show>
          <Show when={state.previewVisible || state.viewerMaximized}>
            <div class="preview-pane"
              style={{ 'flex-grow': state.viewerMaximized ? 1 : 1 - state.editorRatio, 'flex-basis': 0 }}>
              <PreviewPane />
            </div>
          </Show>
        </Show>
      </div>

      <Show when={!state.zenMode}><StatusBar /></Show>
      <ConfigDialog />
      <ContextMenu />
      <Wizards />
      <NewDocDialog />
    </>
  );
}
