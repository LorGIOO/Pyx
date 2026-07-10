import RibbonGroup from '../RibbonGroup.jsx';
import RibbonButton from '../RibbonButton.jsx';
import { icons } from '../icons.js';
import { messageDialog } from '../../../../core/platform.js';

export default function HelpTab() {
  const about = () =>
    messageDialog(
      `Pyx v${__APP_VERSION__}\n\nLaTeX editor with Jupyter-style Python cells.\n` +
        `Insert %#python ... %#end cells and bring the results into the document with \\py{expression}.`,
      { title: 'About Pyx' }
    );

  return (
    <>
      <RibbonGroup label="Help">
        <RibbonButton icon={icons.help} label="About" onClick={about} />
      </RibbonGroup>

      <RibbonGroup label="Shortcuts">
        <div class="ribbon-field" style={{ 'font-size': '11px', color: 'var(--theme-text-secondary)', 'max-width': '360px', 'line-height': '1.5' }}>
          <div><b>Shift+Enter</b> run cell · <b>Ctrl+S</b> save</div>
          <div><b>Ctrl+Shift+B</b> compile · <b>Ctrl+F</b> find</div>
          <div><b>Ctrl+N</b> new · <b>Ctrl+O</b> open · <b>Ctrl+Z/Y</b> undo/redo</div>
        </div>
      </RibbonGroup>
    </>
  );
}
