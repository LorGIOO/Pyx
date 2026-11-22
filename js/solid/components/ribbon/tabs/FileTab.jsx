import RibbonGroup from '../RibbonGroup.jsx';
import RibbonButton from '../RibbonButton.jsx';
import { icons } from '../icons.js';
import { state } from '../../../../core/state.js';
import { t } from '../../../../core/i18n.js';
import { openDocument, saveActive, saveActiveAs, closeActive } from '../../../stores/docStore.js';
import { openNewDoc } from '../../NewDocDialog.jsx';
import { openProjectFolder, closeProjectFolder, projectFolder } from '../../../stores/projectStore.js';
import { invoke, openExternal, revealInExplorer } from '../../../../core/platform.js';

// What ships with Pyx in its installation folder; the web when this build
// does not carry it (a development run).
async function openManual() {
  try {
    const pdf = await invoke('resource_path', { name: 'manual/Manual de usuario de Pyx.pdf' });
    const { loadPdf } = await import('../../../../pdf/preview.js');
    state.previewVisible = true;
    await loadPdf(pdf);
  } catch (_) { openExternal('https://lorgioo.github.io/Pyx-web/manual/'); }
}
async function openExamples() {
  try { await revealInExplorer(await invoke('resource_path', { name: 'ejemplos/LEEME.txt' })); }
  catch (_) { openExternal('https://lorgioo.github.io/Pyx-web/ejemplos/'); }
}

export default function FileTab() {
  const hasDoc = () => state.documents.length > 0;
  return (
    <>
      <RibbonGroup id="file" icon={icons.open} label={t('Archivo', 'File')}>
        <RibbonButton icon={icons.newDoc} label={t('Nuevo', 'New')} onClick={openNewDoc} />
        <RibbonButton icon={icons.open} label={t('Abrir', 'Open')} onClick={() => openDocument()} />
        <RibbonButton icon={icons.folder} label={t('Abrir carpeta', 'Open folder')} onClick={() => openProjectFolder()} />
        <RibbonButton icon={icons.clear} label={t('Cerrar carpeta', 'Close folder')} disabled={!projectFolder()} onClick={() => closeProjectFolder()} />
      </RibbonGroup>
      <RibbonGroup id="save" icon={icons.save} label={t('Guardar', 'Save')}>
        <RibbonButton icon={icons.save} label={t('Guardar', 'Save')} disabled={!hasDoc()} onClick={() => saveActive()} />
        <RibbonButton icon={icons.saveAs} label={t('Guardar como', 'Save as')} disabled={!hasDoc()} onClick={() => saveActiveAs()} />
      </RibbonGroup>
      <RibbonGroup id="help" icon={icons.help} label={t('Ayuda', 'Help')}>
        <RibbonButton icon={icons.book} label={t('Manual', 'Manual')} onClick={openManual} />
        <RibbonButton icon={icons.folder} label={t('Ejemplos', 'Examples')} onClick={openExamples} />
      </RibbonGroup>
      <RibbonGroup id="session" icon={icons.clear} label={t('Sesión', 'Session')}>
        <RibbonButton icon={icons.clear} label={t('Cerrar', 'Close')} disabled={!hasDoc()} onClick={() => closeActive()} />
      </RibbonGroup>
    </>
  );
}
