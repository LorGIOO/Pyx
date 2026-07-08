import { createSignal, onMount } from 'solid-js';
import RibbonGroup from '../RibbonGroup.jsx';
import RibbonButton from '../RibbonButton.jsx';
import RibbonDropdown from '../RibbonDropdown.jsx';
import { icons } from '../icons.js';
import { state } from '../../../../core/state.js';
import {
  runCurrentCell, runAll, clearOutputs, insertCell, toggleHideOutputs, toggleCollapseAll,
} from '../../../../editor/commands.js';
import { restartKernel, setKernelPython, interruptKernel } from '../../../../editor/cell-runner.js';
import { listPythons, openExeDialog } from '../../../../core/platform.js';
import { comboOf } from '../../../stores/keysStore.js';

const kb = (id) => (comboOf(id) ? ` (${comboOf(id)})` : '');

const KERNEL_LABEL = {
  idle: 'Inactivo', starting: 'Iniciando…', ready: 'Listo', busy: 'Ejecutando…', error: 'Error',
};

const AUTO = { label: 'Automático', sym: '⚙', exe: null, hint: 'detecta numpy' };
const BROWSE = { label: 'Elegir .exe…', sym: '📁', exe: '__browse__', hint: 'examinar' };

export default function CalcTab() {
  const hasDoc = () => state.documents.length > 0;
  const busy = () => state.kernelStatus === 'busy' || state.kernelStatus === 'starting';

  // The interpreter picker: Automático + every detected Python + "Elegir .exe…".
  const [pyItems, setPyItems] = createSignal([AUTO, BROWSE]);
  onMount(async () => {
    try {
      const list = await listPythons();
      setPyItems([
        AUTO,
        ...list.map((p) => ({
          label: `Python ${p.version}`,
          sym: p.has_numpy ? '🐍' : '∅',
          hint: p.exe,
          exe: p.exe,
        })),
        BROWSE,
      ]);
    } catch (_) { /* keep the defaults */ }
  });
  const onPickPython = async (it) => {
    if (it.exe === '__browse__') {
      const p = await openExeDialog();
      if (p) setKernelPython(p);
      return;
    }
    setKernelPython(it.exe); // null → automatic detection
  };

  return (
    <>
      <RibbonGroup label="Celdas">
        <RibbonButton icon={icons.cell} label="Nueva celda" disabled={!hasDoc()}
          title={`Nueva celda Python${kb('calc.newCell')}`} onClick={insertCell} />
      </RibbonGroup>

      <RibbonGroup label="Ejecutar">
        <RibbonButton icon={icons.run} label="Celda actual" disabled={!hasDoc() || busy()}
          title={`Ejecutar la celda actual${kb('calc.runCell')}`} onClick={runCurrentCell} />
        {/* While the kernel is busy this turns into "Interrumpir" (Jupyter-style). */}
        <RibbonButton
          icon={busy() ? icons.stop : icons.runAll}
          label={busy() ? 'Interrumpir' : 'Todas las celdas'}
          active={busy()}
          disabled={!hasDoc()}
          title={busy() ? 'Interrumpir la ejecución del kernel' : `Ejecutar todas las celdas${kb('calc.runAll')}`}
          onClick={() => (busy() ? interruptKernel() : runAll())} />
      </RibbonGroup>

      <RibbonGroup label="Salidas">
        <RibbonButton
          icon={state.cellsCollapsed ? icons.expandAll : icons.collapseAll}
          label={state.cellsCollapsed ? 'Expandir todas' : 'Minimizar todas'}
          active={state.cellsCollapsed}
          disabled={!hasDoc()}
          onClick={toggleCollapseAll}
          title="Minimiza o expande TODAS las celdas y sus salidas a la vez (no las oculta: se pueden reabrir una a una)"
        />
      </RibbonGroup>

      <RibbonGroup label="Kernel Python">
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.restart} label="Reiniciar"
            title={`Reiniciar el kernel${kb('calc.restart')}`} onClick={restartKernel} />
          <RibbonButton size="small" icon={icons.clear} label="Limpiar salidas" onClick={clearOutputs} />
          <RibbonButton size="small" icon={icons.eyeOff} label="Ocultar salidas" active={state.hideOutputs}
            title="Oculta las salidas (los cálculos siguen ejecutándose y compilándose en el documento)"
            onClick={toggleHideOutputs} />
        </div>
      </RibbonGroup>

      <RibbonGroup label="Intérprete">
        <div class="ribbon-dd-stack">
          <RibbonDropdown caption="Python" memKey="pyinterp" icon={icons.python}
            placeholder="Automático"
            title="Elegir el intérprete de Python (.exe), o Automático"
            items={pyItems()} onPick={onPickPython} />
        </div>
      </RibbonGroup>

      <RibbonGroup label="Estado">
        <div class="ribbon-field">
          <div class="ribbon-field-row">
            <span class={`status-dot ${state.kernelStatus}`}></span>
            <span>{KERNEL_LABEL[state.kernelStatus] || state.kernelStatus}</span>
          </div>
          <div class="ribbon-field-row" style={{
            'font-size': '11px', color: 'var(--theme-text-secondary)',
            'max-width': '230px', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis',
          }}>
            {state.env.python ? `${state.env.python}` : 'Python no detectado'}
          </div>
        </div>
      </RibbonGroup>
    </>
  );
}
