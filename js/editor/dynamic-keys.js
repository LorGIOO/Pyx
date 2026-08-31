// Editor-scoped DYNAMIC keybindings: cell actions (and save) consult the
// keysStore on every keypress, so the user can rebind them live from
// Configuración → Atajos without rebuilding the editor states.

import { Prec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { comboFromEvent, findAction, runAction } from '../solid/stores/keysStore.js';
import { runCellAtCursor, runCellAndAdvance, insertCellTemplate } from './cells.js';

// view-aware handlers; returning false lets the key type normally (e.g. Enter
// when the cursor is NOT inside a cell).
const EDITOR_ACTIONS = {
  'calc.runCell': (view) => runCellAtCursor(view),
  'calc.runAdvance': (view) => runCellAndAdvance(view),
  'calc.newCell': (view) => { insertCellTemplate(view); return true; },
};

export const dynamicKeys = Prec.highest(
  EditorView.domEventHandlers({
    keydown(e, view) {
      const combo = comboFromEvent(e);
      if (!combo) return false;
      const id = findAction(combo);
      if (!id) return false;
      if (EDITOR_ACTIONS[id]) {
        if (EDITOR_ACTIONS[id](view)) {
          e.preventDefault();
          return true;
        }
        return false;
      }
      if (id === 'file.save') {
        e.preventDefault();
        runAction('file.save');
        return true;
      }
      return false; // global actions bubble to the window listener
    },
  })
);
