// Macros — TeXstudio's, but in Python. A macro is a few lines that read the
// selection (`seleccion`), the whole text (`texto`), the cursor's line
// (`linea`) and the document's variables (`variables`), and leave in
// `resultado` what replaces the selection (None: nothing changes). They run
// in the kernel, in a namespace of their own.
//
// Alt+Mayús+1…9 run the first nine; the Cálculo tab lists them all and opens
// the editor (Editar macros…).

import { general, setGeneral } from '../solid/stores/settingsStore.js';
import { state } from '../core/state.js';
import { kernelMacro } from './cell-runner.js';

export const DEFAULT_MACROS = [
  { name: 'Mayúsculas', code: 'resultado = seleccion.upper()' },
  { name: 'Ordenar líneas', code: 'resultado = "\\n".join(sorted(seleccion.splitlines(), key=str.lower))' },
  {
    name: 'Lista (itemize) desde líneas',
    code: 'lineas = [l.strip() for l in seleccion.splitlines() if l.strip()]\n'
      + 'resultado = "\\\\begin{itemize}\\n" + "".join(f"  \\\\item {l}\\n" for l in lineas) + "\\\\end{itemize}"',
  },
  {
    name: 'Tabla de las variables',
    code: '# Una tabla con los números que ha calculado el documento.\n'
      + 'import numbers\n'
      + 'filas = [(k, v) for k, v in variables.items() if not k.startswith("_") and isinstance(v, numbers.Number)]\n'
      + 'cuerpo = "".join(f"  {k.replace(\'_\', chr(92) + \'_\')} & {v:.4g} \\\\\\\\\\n" for k, v in filas)\n'
      + 'resultado = "\\\\begin{tabular}{lr}\\n  \\\\hline\\n  Variable & Valor \\\\\\\\\\n  \\\\hline\\n" + cuerpo + "  \\\\hline\\n\\\\end{tabular}"',
  },
  { name: 'Contar palabras de la selección', code: 'print(len(seleccion.split()), "palabras")' },
];

export function getMacros() {
  return Array.isArray(general.macros) ? general.macros : DEFAULT_MACROS;
}
export function saveMacros(list) {
  setGeneral({ macros: list.map((m) => ({ name: String(m.name || 'Macro'), code: String(m.code || '') })) });
}

/** Run a macro on the active editor. Returns {result?, stdout?, error?}. */
export async function runMacro(macro) {
  const { getViewOfDoc } = await import('./setup.js');
  const d = state.documents[state.activeIndex];
  const view = d ? getViewOfDoc(d.id) : null;
  if (!view) return { error: 'No hay ningún documento abierto.' };
  const sel = view.state.selection.main;
  const res = await kernelMacro(macro.code, {
    selection: view.state.sliceDoc(sel.from, sel.to),
    document: view.state.doc.toString(),
    line: view.state.doc.lineAt(sel.head).number,
  });
  if (res && res.result != null && !res.error) {
    // The selection may have moved while the kernel worked: replace what was selected.
    const cur = view.state.selection.main;
    const from = Math.min(sel.from, view.state.doc.length), to = Math.min(sel.to, view.state.doc.length);
    view.dispatch({
      changes: { from, to, insert: res.result },
      selection: cur.from === sel.from && cur.to === sel.to ? { anchor: from, head: from + res.result.length } : undefined,
      userEvent: 'input.macro',
    });
    view.focus();
  }
  return res || {};
}

/** Alt+Mayús+N (editor keymap). */
export function runMacroIndex(i) {
  const m = getMacros()[i];
  if (!m) return false;
  runMacro(m).then(showMacroResult);
  return true;
}

export async function showMacroResult(res) {
  if (!res || (!res.error && !res.stdout)) return;
  const { messageDialog } = await import('../core/platform.js');
  messageDialog(res.error ? `${res.error}${res.stdout ? `\n\n${res.stdout}` : ''}` : res.stdout,
    { title: 'Macro', kind: res.error ? 'error' : 'info' });
}
