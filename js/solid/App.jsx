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
import { newDocument } from './stores/docStore.js';

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
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                  d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              <h2>No hay ningún documento abierto</h2>
              <p>Crea un documento nuevo o abre un archivo .tex para empezar.</p>
              <div class="hint-keys">
                <span><kbd>Ctrl</kbd> + <kbd>N</kbd> nuevo</span>
                <span><kbd>Ctrl</kbd> + <kbd>O</kbd> abrir</span>
              </div>
              <button class="preview-header" style={{ padding: '6px 14px', cursor: 'default' }} onClick={() => newDocument()}>
                Nuevo documento
              </button>
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
    </>
  );
}
