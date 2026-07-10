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
  idle: 'Idle', starting: 'Starting…', ready: 'Ready', busy: 'Running…', error: 'Error',
};

const AUTO = { label: 'Automatic', sym: '⚙', exe: null, hint: 'detects numpy' };
const BROWSE = { label: 'Choose .exe…', sym: '📁', exe: '__browse__', hint: 'browse' };

export default function CalcTab() {
  const hasDoc = () => state.documents.length > 0;
  const busy = () => state.kernelStatus === 'busy' || state.kernelStatus === 'starting';

  // The interpreter picker: Automatic + every detected Python + "Choose .exe…".
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
      <RibbonGroup label="Cells">
        <RibbonButton icon={icons.cell} label="New cell" disabled={!hasDoc()}
          title={`New Python cell${kb('calc.newCell')}`} onClick={insertCell} />
      </RibbonGroup>

      <RibbonGroup label="Run">
        <RibbonButton icon={icons.run} label="Current cell" disabled={!hasDoc() || busy()}
          title={`Run the current cell${kb('calc.runCell')}`} onClick={runCurrentCell} />
        {/* While the kernel is busy this turns into "Interrupt" (Jupyter-style). */}
        <RibbonButton
          icon={busy() ? icons.stop : icons.runAll}
          label={busy() ? 'Interrupt' : 'All cells'}
          active={busy()}
          disabled={!hasDoc()}
          title={busy() ? 'Interrupt kernel execution' : `Run all cells${kb('calc.runAll')}`}
          onClick={() => (busy() ? interruptKernel() : runAll())} />
      </RibbonGroup>

      <RibbonGroup label="Outputs">
        <RibbonButton
          icon={state.cellsCollapsed ? icons.expandAll : icons.collapseAll}
          label={state.cellsCollapsed ? 'Expand all' : 'Collapse all'}
          active={state.cellsCollapsed}
          disabled={!hasDoc()}
          onClick={toggleCollapseAll}
          title="Collapse or expand ALL cells and their outputs at once (doesn't hide them: they can be reopened one by one)"
        />
      </RibbonGroup>

      <RibbonGroup label="Python kernel">
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.restart} label="Restart"
            title={`Restart the kernel${kb('calc.restart')}`} onClick={restartKernel} />
          <RibbonButton size="small" icon={icons.clear} label="Clear outputs" onClick={clearOutputs} />
          <RibbonButton size="small" icon={icons.eyeOff} label="Hide outputs" active={state.hideOutputs}
            title="Hides the outputs (calculations still run and compile into the document)"
            onClick={toggleHideOutputs} />
        </div>
      </RibbonGroup>

      <RibbonGroup label="Interpreter">
        <div class="ribbon-dd-stack">
          <RibbonDropdown caption="Python" memKey="pyinterp" icon={icons.python}
            placeholder="Automatic"
            title="Choose the Python interpreter (.exe), or Automatic"
            items={pyItems()} onPick={onPickPython} />
        </div>
      </RibbonGroup>

      <RibbonGroup label="Status">
        <div class="ribbon-field">
          <div class="ribbon-field-row">
            <span class={`status-dot ${state.kernelStatus}`}></span>
            <span>{KERNEL_LABEL[state.kernelStatus] || state.kernelStatus}</span>
          </div>
          <div class="ribbon-field-row" style={{
            'font-size': '11px', color: 'var(--theme-text-secondary)',
            'max-width': '230px', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis',
          }}>
            {state.env.python ? `${state.env.python}` : 'Python not detected'}
          </div>
        </div>
      </RibbonGroup>
    </>
  );
}
