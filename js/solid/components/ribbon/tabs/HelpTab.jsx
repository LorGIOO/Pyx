import RibbonGroup from '../RibbonGroup.jsx';
import RibbonButton from '../RibbonButton.jsx';
import { icons } from '../icons.js';
import { messageDialog } from '../../../../core/platform.js';

export default function HelpTab() {
  const about = () =>
    messageDialog(
      `Calc v${__APP_VERSION__}\n\nEditor LaTeX con celdas Python tipo Jupyter.\n` +
        `Inserta celdas %#python ... %#end y trae los resultados al documento con \\py{expresión}.`,
      { title: 'Acerca de Calc' }
    );

  return (
    <>
      <RibbonGroup label="Ayuda">
        <RibbonButton icon={icons.help} label="Acerca de" onClick={about} />
      </RibbonGroup>

      <RibbonGroup label="Atajos">
        <div class="ribbon-field" style={{ 'font-size': '11px', color: 'var(--theme-text-secondary)', 'max-width': '360px', 'line-height': '1.5' }}>
          <div><b>Shift+Enter</b> ejecutar celda · <b>Ctrl+S</b> guardar</div>
          <div><b>Ctrl+Shift+B</b> compilar · <b>Ctrl+F</b> buscar</div>
          <div><b>Ctrl+N</b> nuevo · <b>Ctrl+O</b> abrir · <b>Ctrl+Z/Y</b> deshacer/rehacer</div>
        </div>
      </RibbonGroup>
    </>
  );
}
