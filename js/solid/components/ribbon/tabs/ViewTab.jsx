import RibbonGroup from '../RibbonGroup.jsx';
import RibbonButton from '../RibbonButton.jsx';
import { icons } from '../icons.js';
import { state } from '../../../../core/state.js';
import { splitActivePane, closePane } from '../../../stores/docStore.js';

export default function ViewTab() {
  return (
    <>
      <RibbonGroup label="Editor">
        <RibbonButton icon={icons.splitV} label="Dividir editor" disabled={!state.documents.length}
          onClick={splitActivePane}
          title="Divide el editor verticalmente (también: arrastra una pestaña al borde derecho de un panel)" />
        <RibbonButton icon={icons.preview} label="Cerrar panel" disabled={state.panes.length <= 1}
          onClick={() => closePane(state.activePaneId)} />
        <RibbonButton icon={icons.zen} label="Modo zen" active={state.zenMode}
          onClick={() => (state.zenMode = !state.zenMode)}
          title="Solo pestañas + editor + visor; todo con teclado (Ctrl+Alt+Z). Esc para salir" />
      </RibbonGroup>

      <RibbonGroup label="Paneles">
        <RibbonButton icon={icons.preview} label="Vista previa" active={state.previewVisible}
          onClick={() => (state.previewVisible = !state.previewVisible)} />
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.sidebar} label="Panel lateral" active={!state.sidePanelHidden}
            onClick={() => (state.sidePanelHidden = !state.sidePanelHidden)}
            title="Mostrar u ocultar el panel lateral (estructura, símbolos, archivos…)" />
          <RibbonButton size="small" icon={icons.log} label="Registro" active={state.logVisible}
            onClick={() => (state.logVisible = !state.logVisible)} />
          <RibbonButton size="small" icon={icons.terminal} label="Terminal" active={state.terminalVisible}
            onClick={() => (state.terminalVisible = !state.terminalVisible)}
            title="Terminal para instalar paquetes (pip install ...) y ejecutar comandos" />
        </div>
      </RibbonGroup>
    </>
  );
}
