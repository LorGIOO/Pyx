import RibbonGroup from '../RibbonGroup.jsx';
import RibbonButton from '../RibbonButton.jsx';
import { icons } from '../icons.js';
import { t } from '../../../../core/i18n.js';
import { messageDialog } from '../../../../core/platform.js';

export default function HelpTab() {
  const about = () =>
    messageDialog(
      `Pyx v${__APP_VERSION__}\n\n` +
        t(
          'Editor LaTeX con celdas Python tipo Jupyter.\nInserta celdas %#python ... %#end y trae los resultados al documento con \\py{expresión}.',
          'LaTeX editor with Jupyter-style Python cells.\nInsert %#python ... %#end cells and bring the results into the document with \\py{expression}.',
        ),
      { title: t('Acerca de Pyx', 'About Pyx') }
    );

  return (
    <>
      <RibbonGroup label={t('Ayuda', 'Help')}>
        <RibbonButton icon={icons.help} label={t('Acerca de', 'About')} onClick={about} />
      </RibbonGroup>

      <RibbonGroup label={t('Atajos', 'Shortcuts')}>
        <div class="ribbon-field" style={{ 'font-size': '11px', color: 'var(--theme-text-secondary)', 'max-width': '360px', 'line-height': '1.5' }}>
          <div><b>Shift+Enter</b> {t('ejecutar celda', 'run cell')} · <b>Ctrl+S</b> {t('guardar', 'save')}</div>
          <div><b>Ctrl+Shift+B</b> {t('compilar', 'compile')} · <b>Ctrl+F</b> {t('buscar', 'find')}</div>
          <div><b>Ctrl+N</b> {t('nuevo', 'new')} · <b>Ctrl+O</b> {t('abrir', 'open')} · <b>Ctrl+Z/Y</b> {t('deshacer/rehacer', 'undo/redo')}</div>
        </div>
      </RibbonGroup>
    </>
  );
}
