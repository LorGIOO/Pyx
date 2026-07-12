import { createSignal, onMount } from 'solid-js';
import RibbonGroup from '../RibbonGroup.jsx';
import RibbonButton from '../RibbonButton.jsx';
import RibbonDropdown from '../RibbonDropdown.jsx';
import { icons } from '../icons.js';
import { state } from '../../../../core/state.js';
import { t } from '../../../../core/i18n.js';
import {
  runCurrentCell, runAll, clearOutputs, insertCell, toggleHideOutputs, toggleCollapseAll,
} from '../../../../editor/commands.js';
import { restartKernel, setKernelPython, interruptKernel } from '../../../../editor/cell-runner.js';
import { listPythons, openExeDialog } from '../../../../core/platform.js';
import { comboOf } from '../../../stores/keysStore.js';

const kb = (id) => (comboOf(id) ? ` (${comboOf(id)})` : '');

const kernelLabel = () => ({
  idle: t('Inactivo', 'Idle'), starting: t('Iniciando…', 'Starting…'), ready: t('Listo', 'Ready'),
  busy: t('Ejecutando…', 'Running…'), error: t('Error', 'Error'),
});

const AUTO = () => ({ label: t('Automático', 'Automatic'), sym: '⚙', exe: null, hint: t('detecta numpy', 'detects numpy') });
const BROWSE = () => ({ label: t('Elegir .exe…', 'Choose .exe…'), sym: '📁', exe: '__browse__', hint: t('examinar', 'browse') });

export default function CalcTab() {
  const hasDoc = () => state.documents.length > 0;
  const busy = () => state.kernelStatus === 'busy' || state.kernelStatus === 'starting';

  // The interpreter picker: Automatic + every detected Python + "Choose .exe…".
  const [pyItems, setPyItems] = createSignal([AUTO(), BROWSE()]);
  onMount(async () => {
    try {
      const list = await listPythons();
      setPyItems([
        AUTO(),
        ...list.map((p) => ({
          label: `Python ${p.version}`,
          sym: p.has_numpy ? '🐍' : '∅',
          hint: p.exe,
          exe: p.exe,
        })),
        BROWSE(),
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
      <RibbonGroup label={t('Celdas', 'Cells')}>
        <RibbonButton icon={icons.cell} label={t('Nueva celda', 'New cell')} disabled={!hasDoc()}
          title={`${t('Nueva celda Python', 'New Python cell')}${kb('calc.newCell')}`} onClick={insertCell} />
      </RibbonGroup>

      <RibbonGroup label={t('Ejecutar', 'Run')}>
        <RibbonButton icon={icons.run} label={t('Celda actual', 'Current cell')} disabled={!hasDoc() || busy()}
          title={`${t('Ejecutar la celda actual', 'Run the current cell')}${kb('calc.runCell')}`} onClick={runCurrentCell} />
        {/* While the kernel is busy this turns into "Interrupt" (Jupyter-style). */}
        <RibbonButton
          icon={busy() ? icons.stop : icons.runAll}
          label={busy() ? t('Interrumpir', 'Interrupt') : t('Todas las celdas', 'All cells')}
          active={busy()}
          disabled={!hasDoc()}
          title={busy() ? t('Interrumpir la ejecución del kernel', 'Interrupt kernel execution') : `${t('Ejecutar todas las celdas', 'Run all cells')}${kb('calc.runAll')}`}
          onClick={() => (busy() ? interruptKernel() : runAll())} />
      </RibbonGroup>

      <RibbonGroup label={t('Salidas', 'Outputs')}>
        <RibbonButton
          icon={state.cellsCollapsed ? icons.expandAll : icons.collapseAll}
          label={state.cellsCollapsed ? t('Expandir todas', 'Expand all') : t('Minimizar todas', 'Collapse all')}
          active={state.cellsCollapsed}
          disabled={!hasDoc()}
          onClick={toggleCollapseAll}
          title={t(
            'Minimiza o expande TODAS las celdas y sus salidas a la vez (no las oculta: se pueden reabrir una a una)',
            "Collapse or expand ALL cells and their outputs at once (doesn't hide them: they can be reopened one by one)",
          )}
        />
      </RibbonGroup>

      <RibbonGroup label={t('Kernel Python', 'Python kernel')}>
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.restart} label={t('Reiniciar', 'Restart')}
            title={`${t('Reiniciar el kernel', 'Restart the kernel')}${kb('calc.restart')}`} onClick={restartKernel} />
          <RibbonButton size="small" icon={icons.clear} label={t('Limpiar salidas', 'Clear outputs')} onClick={clearOutputs} />
          <RibbonButton size="small" icon={icons.eyeOff} label={t('Ocultar salidas', 'Hide outputs')} active={state.hideOutputs}
            title={t('Oculta las salidas (los cálculos siguen ejecutándose y compilándose en el documento)', 'Hides the outputs (calculations still run and compile into the document)')}
            onClick={toggleHideOutputs} />
        </div>
      </RibbonGroup>

      <RibbonGroup label={t('Intérprete', 'Interpreter')}>
        <div class="ribbon-dd-stack">
          <RibbonDropdown caption="Python" memKey="pyinterp" icon={icons.python}
            placeholder={t('Automático', 'Automatic')}
            title={t('Elegir el intérprete de Python (.exe), o Automático', 'Choose the Python interpreter (.exe), or Automatic')}
            items={pyItems()} onPick={onPickPython} />
        </div>
      </RibbonGroup>

      <RibbonGroup label={t('Estado', 'Status')}>
        <div class="ribbon-field">
          <div class="ribbon-field-row">
            <span class={`status-dot ${state.kernelStatus}`}></span>
            <span>{kernelLabel()[state.kernelStatus] || state.kernelStatus}</span>
          </div>
          <div class="ribbon-field-row" style={{
            'font-size': '11px', color: 'var(--theme-text-secondary)',
            'max-width': '230px', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis',
          }}>
            {state.env.python ? `${state.env.python}` : t('Python no detectado', 'Python not detected')}
          </div>
        </div>
      </RibbonGroup>
    </>
  );
}
