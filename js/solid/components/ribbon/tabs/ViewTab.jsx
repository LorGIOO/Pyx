import RibbonGroup from '../RibbonGroup.jsx';
import RibbonButton from '../RibbonButton.jsx';
import { icons } from '../icons.js';
import { state } from '../../../../core/state.js';
import { splitActivePane, closePane } from '../../../stores/docStore.js';

export default function ViewTab() {
  return (
    <>
      <RibbonGroup label="Editor">
        <RibbonButton icon={icons.splitV} label="Split editor" disabled={!state.documents.length}
          onClick={splitActivePane}
          title="Split the editor vertically (also: drag a tab to the right edge of a pane)" />
        <RibbonButton icon={icons.preview} label="Close pane" disabled={state.panes.length <= 1}
          onClick={() => closePane(state.activePaneId)} />
        <RibbonButton icon={icons.zen} label="Zen mode" active={state.zenMode}
          onClick={() => (state.zenMode = !state.zenMode)}
          title="Only tabs + editor + viewer; all keyboard-driven (Ctrl+Alt+Z). Esc to exit" />
      </RibbonGroup>

      <RibbonGroup label="Panels">
        <RibbonButton icon={icons.preview} label="Preview" active={state.previewVisible}
          onClick={() => (state.previewVisible = !state.previewVisible)} />
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.sidebar} label="Side panel" active={!state.sidePanelHidden}
            onClick={() => (state.sidePanelHidden = !state.sidePanelHidden)}
            title="Show or hide the side panel (structure, symbols, files…)" />
          <RibbonButton size="small" icon={icons.log} label="Log" active={state.logVisible}
            onClick={() => (state.logVisible = !state.logVisible)} />
          <RibbonButton size="small" icon={icons.terminal} label="Terminal" active={state.terminalVisible}
            onClick={() => (state.terminalVisible = !state.terminalVisible)}
            title="Terminal to install packages (pip install ...) and run commands" />
        </div>
      </RibbonGroup>
    </>
  );
}
