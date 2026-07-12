import RibbonGroup from '../RibbonGroup.jsx';
import RibbonButton from '../RibbonButton.jsx';
import { icons } from '../icons.js';
import { state } from '../../../../core/state.js';
import { t } from '../../../../core/i18n.js';
import { openDocument, saveActive, saveActiveAs, closeActive } from '../../../stores/docStore.js';
import { openNewDoc } from '../../NewDocDialog.jsx';

export default function FileTab() {
  const hasDoc = () => state.documents.length > 0;
  return (
    <>
      <RibbonGroup label={t('Archivo', 'File')}>
        <RibbonButton icon={icons.newDoc} label={t('Nuevo', 'New')} onClick={openNewDoc} />
        <RibbonButton icon={icons.open} label={t('Abrir', 'Open')} onClick={() => openDocument()} />
      </RibbonGroup>
      <RibbonGroup label={t('Guardar', 'Save')}>
        <RibbonButton icon={icons.save} label={t('Guardar', 'Save')} disabled={!hasDoc()} onClick={() => saveActive()} />
        <RibbonButton icon={icons.saveAs} label={t('Guardar como', 'Save as')} disabled={!hasDoc()} onClick={() => saveActiveAs()} />
      </RibbonGroup>
      <RibbonGroup label={t('Sesión', 'Session')}>
        <RibbonButton icon={icons.clear} label={t('Cerrar', 'Close')} disabled={!hasDoc()} onClick={() => closeActive()} />
      </RibbonGroup>
    </>
  );
}
