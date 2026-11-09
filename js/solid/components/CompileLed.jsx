import { state } from '../../core/state.js';
import { t } from '../../core/i18n.js';
import { compileStatus } from '../stores/compileStatus.js';
import { problems, firstError, gotoProblem } from '../stores/problemsStore.js';
import { comboOf } from '../stores/keysStore.js';
import { cancelCompile } from '../../compile/compiler.js';
import { showContextMenu } from './ContextMenu.jsx';
import { icons } from './ribbon/icons.js';

// The compile LED: one coloured dot at the end of the document tabs.
//
// Zen mode hides the ribbon and the status bar — the only two places that
// said whether a compile was running, had finished or had failed. Writing
// with live compile on, in zen, meant watching the PDF and guessing. The tab
// strip is the one piece of chrome zen keeps, so the dot lives there: it is
// always in sight and never on top of the text or the PDF.
//
// Colour and wording come from compileStatus (the same answer the status bar
// gives). A click goes to the first error — in ITS file — or, with no error
// to go to, shows or hides the log. Right-click has the rest.
export default function CompileLed() {
  const st = compileStatus;

  const hint = () => {
    const k = st().kind;
    if ((k === 'error' || k === 'warn') && firstError(problems())) return t('Clic: ir al error', 'Click: go to the error');
    return state.logVisible ? t('Clic: ocultar el registro', 'Click: hide the log') : t('Clic: ver el registro', 'Click: show the log');
  };
  // One line: the hover widget (Tooltip.jsx) follows changes of `title`, so
  // this updates under the pointer while a compile goes through its phases.
  const tip = () => [st().label, st().detail, hint()].filter(Boolean).join(' — ');

  const toggleLog = () => { state.logVisible = !state.logVisible; };
  const onClick = async () => {
    const k = st().kind;
    if (k === 'error' || k === 'warn') {
      const p = firstError(problems());
      if (p && await gotoProblem(p)) return;
    }
    // Nothing to jump to (no error, or one inside a package): the log is
    // where the explanation is.
    toggleLog();
  };

  const onMenu = (e) => {
    const items = [
      {
        label: state.logVisible ? t('Cerrar registro', 'Close log') : t('Abrir registro', 'Open log'),
        icon: icons.log,
        shortcut: comboOf('view.log') || undefined,
        onClick: toggleLog,
      },
      {
        label: t('Detener compilación', 'Stop compiling'),
        icon: icons.stop,
        shortcut: comboOf('compile.stop') || undefined,
        disabled: !state.compiling,
        onClick: () => cancelCompile(),
      },
    ];
    if (state.zenMode) {
      items.push({ separator: true }, {
        label: t('Salir de zen', 'Exit zen'),
        icon: icons.zen,
        shortcut: comboOf('view.zen') || 'Esc',
        onClick: () => { state.zenMode = false; },
      });
    }
    showContextMenu(e, items);
  };

  return (
    <button class="compile-led" type="button" data-kind={st().kind} title={tip()}
      aria-label={t('Estado de la compilación', 'Compile status')}
      onClick={onClick} onContextMenu={onMenu}>
      <span class="compile-led-dot"></span>
      {/* Read out when it changes, without stealing focus from the editor. */}
      <span class="compile-led-sr" role="status" aria-live="polite">
        {st().detail ? `${st().label}. ${st().detail}` : st().label}
      </span>
    </button>
  );
}
