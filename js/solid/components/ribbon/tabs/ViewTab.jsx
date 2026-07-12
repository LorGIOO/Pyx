import RibbonGroup from '../RibbonGroup.jsx';
import RibbonButton from '../RibbonButton.jsx';
import { icons } from '../icons.js';
import { state } from '../../../../core/state.js';
import { t } from '../../../../core/i18n.js';
import { splitActivePane, closePane } from '../../../stores/docStore.js';

export default function ViewTab() {
  return (
    <>
      <RibbonGroup label={t('Editor', 'Editor')}>
        <RibbonButton icon={icons.splitV} label={t('Dividir editor', 'Split editor')} disabled={!state.documents.length}
          onClick={splitActivePane}
          title={t('Divide el editor verticalmente (también: arrastra una pestaña al borde derecho de un panel)', 'Split the editor vertically (also: drag a tab to the right edge of a pane)')} />
        <RibbonButton icon={icons.preview} label={t('Cerrar panel', 'Close pane')} disabled={state.panes.length <= 1}
          onClick={() => closePane(state.activePaneId)} />
        <RibbonButton icon={icons.zen} label={t('Modo zen', 'Zen mode')} active={state.zenMode}
          onClick={() => (state.zenMode = !state.zenMode)}
          title={t('Solo pestañas + editor + visor; todo con teclado (Ctrl+Alt+Z). Esc para salir', 'Only tabs + editor + viewer; all keyboard-driven (Ctrl+Alt+Z). Esc to exit')} />
      </RibbonGroup>

      <RibbonGroup label={t('Paneles', 'Panels')}>
        <RibbonButton icon={icons.preview} label={t('Vista previa', 'Preview')} active={state.previewVisible}
          onClick={() => (state.previewVisible = !state.previewVisible)} />
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.sidebar} label={t('Panel lateral', 'Side panel')} active={!state.sidePanelHidden}
            onClick={() => (state.sidePanelHidden = !state.sidePanelHidden)}
            title={t('Mostrar u ocultar el panel lateral (estructura, símbolos, archivos…)', 'Show or hide the side panel (structure, symbols, files…)')} />
          <RibbonButton size="small" icon={icons.log} label={t('Registro', 'Log')} active={state.logVisible}
            onClick={() => (state.logVisible = !state.logVisible)} />
          <RibbonButton size="small" icon={icons.terminal} label={t('Terminal', 'Terminal')} active={state.terminalVisible}
            onClick={() => (state.terminalVisible = !state.terminalVisible)}
            title={t('Terminal para instalar paquetes (pip install ...) y ejecutar comandos', 'Terminal to install packages (pip install ...) and run commands')} />
        </div>
      </RibbonGroup>
    </>
  );
}
