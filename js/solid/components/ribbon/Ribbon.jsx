import { Switch, Match, Show, createEffect } from 'solid-js';
import RibbonTab from './RibbonTab.jsx';
import { activeTab, setActiveTab } from '../../stores/ribbonStore.js';
import { activeDoc } from '../../../core/state.js';
import { t } from '../../../core/i18n.js';
import { isPyxDoc } from '../../stores/docStore.js';
import FileTab from './tabs/FileTab.jsx';
import HomeTab from './tabs/HomeTab.jsx';
import MathTab from './tabs/MathTab.jsx';
import CalcTab from './tabs/CalcTab.jsx';
import ViewTab from './tabs/ViewTab.jsx';

export default function Ribbon() {
  // Plain .tex documents hide the Python features (Python tab): they compile
  // and preview normally, but cells/kernel are a Pyx (.pltx) capability.
  const showCalc = () => isPyxDoc(activeDoc()) || !activeDoc();
  createEffect(() => {
    if (!showCalc() && activeTab() === 'calc') setActiveTab('home');
    if (activeTab() === 'insert') setActiveTab('home'); // tab removed
  });
  return (
    <>
      <div class="ribbon-tabs">
        <RibbonTab label={t('Archivo', 'File')} fileTab active={activeTab() === 'file'} onClick={() => setActiveTab('file')} />
        <RibbonTab label={t('Inicio', 'Home')} active={activeTab() === 'home'} onClick={() => setActiveTab('home')} />
        <RibbonTab label={t('Matemáticas', 'Math')} active={activeTab() === 'math'} onClick={() => setActiveTab('math')} />
        <Show when={showCalc()}>
          <RibbonTab label="Python" active={activeTab() === 'calc'} onClick={() => setActiveTab('calc')} />
        </Show>
        <RibbonTab label={t('Ver', 'View')} active={activeTab() === 'view'} onClick={() => setActiveTab('view')} />
      </div>

      <div class="ribbon-content">
        <Switch>
          <Match when={activeTab() === 'file'}><FileTab /></Match>
          <Match when={activeTab() === 'home'}><HomeTab /></Match>
          <Match when={activeTab() === 'math'}><MathTab /></Match>
          <Match when={activeTab() === 'calc'}><CalcTab /></Match>
          <Match when={activeTab() === 'view'}><ViewTab /></Match>
        </Switch>
      </div>
    </>
  );
}
