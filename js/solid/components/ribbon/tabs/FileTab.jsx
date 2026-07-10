import RibbonGroup from '../RibbonGroup.jsx';
import RibbonButton from '../RibbonButton.jsx';
import { icons } from '../icons.js';
import { state } from '../../../../core/state.js';
import { newDocument, openDocument, saveActive, saveActiveAs, closeActive } from '../../../stores/docStore.js';

export default function FileTab() {
  const hasDoc = () => state.documents.length > 0;
  return (
    <>
      <RibbonGroup label="File">
        <RibbonButton icon={icons.newDoc} label="New" onClick={() => newDocument()} />
        <RibbonButton icon={icons.open} label="Open" onClick={() => openDocument()} />
      </RibbonGroup>
      <RibbonGroup label="Save">
        <RibbonButton icon={icons.save} label="Save" disabled={!hasDoc()} onClick={() => saveActive()} />
        <RibbonButton icon={icons.saveAs} label="Save as" disabled={!hasDoc()} onClick={() => saveActiveAs()} />
      </RibbonGroup>
      <RibbonGroup label="Session">
        <RibbonButton icon={icons.clear} label="Close" disabled={!hasDoc()} onClick={() => closeActive()} />
      </RibbonGroup>
    </>
  );
}
