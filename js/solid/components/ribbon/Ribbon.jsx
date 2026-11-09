import { Switch, Match, Show, createEffect, on, onCleanup } from 'solid-js';
import RibbonTab from './RibbonTab.jsx';
import { activeTab, setActiveTab } from '../../stores/ribbonStore.js';
import { activeDoc } from '../../../core/state.js';
import { t, lang } from '../../../core/i18n.js';
import { isPyxDoc } from '../../stores/docStore.js';
import { RibbonLayoutContext, createRibbonLayout } from './ribbonLayout.js';
import FileTab from './tabs/FileTab.jsx';
import HomeTab, { HOME_LAYOUT } from './tabs/HomeTab.jsx';
import MathTab, { MATH_LAYOUT } from './tabs/MathTab.jsx';
import CalcTab, { CALC_LAYOUT } from './tabs/CalcTab.jsx';
import ViewTab from './tabs/ViewTab.jsx';

// How each tab gives way when the window is narrower than its groups (see
// ribbonLayout.js). Archivo and Ver are short enough to declare nothing: if a
// window ever is too narrow for them, their groups collapse from the right.
const LAYOUTS = { home: HOME_LAYOUT, math: MATH_LAYOUT, calc: CALC_LAYOUT };

export default function Ribbon() {
  // Plain .tex documents hide the Python features (Python tab): they compile
  // and preview normally, but cells/kernel are a Pyx (.pltx) capability.
  const showCalc = () => isPyxDoc(activeDoc()) || !activeDoc();
  createEffect(() => {
    if (!showCalc() && activeTab() === 'calc') setActiveTab('home');
    if (activeTab() === 'insert') setActiveTab('home'); // tab removed
  });

  const layout = createRibbonLayout(() => LAYOUTS[activeTab()]);
  onCleanup(layout.dispose);
  // A new tab re-plans by itself (its groups register as they mount). A new
  // language does not always: a label can change to one of the same width as
  // far as the observer can tell, and still wrap differently.
  createEffect(on(lang, () => layout.schedule(), { defer: true }));

  return (
    <RibbonLayoutContext.Provider value={layout}>
      <div class="ribbon-tabs">
        <RibbonTab label={t('Archivo', 'File')} fileTab active={activeTab() === 'file'} onClick={() => setActiveTab('file')} />
        <RibbonTab label={t('Inicio', 'Home')} active={activeTab() === 'home'} onClick={() => setActiveTab('home')} />
        <RibbonTab label={t('Matemáticas', 'Math')} active={activeTab() === 'math'} onClick={() => setActiveTab('math')} />
        <Show when={showCalc()}>
          <RibbonTab label="Python" active={activeTab() === 'calc'} onClick={() => setActiveTab('calc')} />
        </Show>
        <RibbonTab label={t('Ver', 'View')} active={activeTab() === 'view'} onClick={() => setActiveTab('view')} />
      </div>

      <div class="ribbon-content" ref={layout.setRoot}>
        <Switch>
          <Match when={activeTab() === 'file'}><FileTab /></Match>
          <Match when={activeTab() === 'home'}><HomeTab /></Match>
          <Match when={activeTab() === 'math'}><MathTab /></Match>
          <Match when={activeTab() === 'calc'}><CalcTab /></Match>
          <Match when={activeTab() === 'view'}><ViewTab /></Match>
        </Switch>
      </div>
    </RibbonLayoutContext.Provider>
  );
}
