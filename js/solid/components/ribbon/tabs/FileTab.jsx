import RibbonGroup from '../RibbonGroup.jsx';
import RibbonButton from '../RibbonButton.jsx';
import { icons } from '../icons.js';
import { state } from '../../../../core/state.js';
import { newDocument, openDocument, saveActive, saveActiveAs, closeActive } from '../../../stores/docStore.js';

export default function FileTab() {
  const hasDoc = () => state.documents.length > 0;
  return (
    <>
      <RibbonGroup label="Archivo">
        <RibbonButton icon={icons.newDoc} label="Nuevo" onClick={() => newDocument()} />
        <RibbonButton icon={icons.open} label="Abrir" onClick={() => openDocument()} />
      </RibbonGroup>
      <RibbonGroup label="Guardar">
        <RibbonButton icon={icons.save} label="Guardar" disabled={!hasDoc()} onClick={() => saveActive()} />
        <RibbonButton icon={icons.saveAs} label="Guardar como" disabled={!hasDoc()} onClick={() => saveActiveAs()} />
      </RibbonGroup>
      <RibbonGroup label="Sesión">
        <RibbonButton icon={icons.clear} label="Cerrar" disabled={!hasDoc()} onClick={() => closeActive()} />
      </RibbonGroup>
    </>
  );
}
