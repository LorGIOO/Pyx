import RibbonGroup from '../RibbonGroup.jsx';
import RibbonButton from '../RibbonButton.jsx';
import RibbonDropdown from '../RibbonDropdown.jsx';
import { icons } from '../icons.js';
import { state } from '../../../../core/state.js';
import { setGeneral } from '../../../stores/settingsStore.js';
import {
  openFind, clip, wrap, changeCase,
  tblAddRow, tblAddCol, tblDelRow, tblDelCol, tblHline, tblAlign,
} from '../../../../editor/commands.js';
import { compileActive } from '../../../../compile/compiler.js';
import { rerender } from '../../../../pdf/preview.js';
import { comboOf } from '../../../stores/keysStore.js';
import { openTableWizard, openFigureWizard } from '../../Wizards.jsx';
import {
  STRUCTURE, FONT_SIZES, LABELS, ALIGN, LISTS, runSnippet,
} from '../../../../data/latex-snippets.js';

// "Aa" change-case menu (Word-style).
const CASE_OPTIONS = [
  { label: 'MAYÚSCULAS', sym: 'AA', hint: 'UPPER', mode: 'upper' },
  { label: 'minúsculas', sym: 'aa', hint: 'lower', mode: 'lower' },
  { label: 'Tipo oración (solo la inicial)', sym: 'Ab', hint: 'Sentence', mode: 'sentence' },
  { label: 'Cada Palabra En Mayúscula', sym: 'Tt', hint: 'Title', mode: 'title' },
  { label: 'aLTERNAR mAYÚS/minús', sym: 'aA', hint: 'tOGGLE', mode: 'toggle' },
];

// Column-alignment menu (TeXstudio's "align column" — sets the spec to l/c/r).
const COL_ALIGN = [
  { label: 'Izquierda', badge: 'l', a: 'l' },
  { label: 'Centrada', badge: 'c', a: 'c' },
  { label: 'Derecha', badge: 'r', a: 'r' },
];

export default function HomeTab() {
  const hasDoc = () => state.documents.length > 0;
  const busy = () => !hasDoc() || state.compiling;
  const visualizar = () => { state.previewVisible = true; rerender(); };

  return (
    <>
      <RibbonGroup label="Portapapeles">
        <RibbonButton icon={icons.paste} label="Pegar" onClick={() => clip('paste')} />
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.cut} label="Cortar" onClick={() => clip('cut')} />
          <RibbonButton size="small" icon={icons.copy} label="Copiar" onClick={() => clip('copy')} />
          <RibbonButton size="small" icon={icons.find} label="Buscar" onClick={openFind} />
        </div>
      </RibbonGroup>

      <RibbonGroup label="Compilación">
        <RibbonButton icon={icons.compile} label="Compilar y ver" disabled={busy()}
          title={`Compilar y ver el PDF${comboOf('compile.run') ? ` (${comboOf('compile.run')})` : ''}`}
          onClick={() => compileActive(true)} />
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.pdf} label="Compilar" disabled={busy()}
            title="Compilar en segundo plano (sin abrir el visor)" onClick={() => compileActive(false)} />
          <RibbonButton size="small" icon={icons.preview} label="Visualizar" disabled={!hasDoc()} onClick={visualizar} />
          <RibbonButton size="small" icon={icons.live} label="Al escribir" active={state.liveCompile}
            title="Compilación automática al dejar de escribir (no bloquea el editor)"
            onClick={() => { state.liveCompile = !state.liveCompile; setGeneral({ liveCompile: state.liveCompile }); }} />
        </div>
      </RibbonGroup>

      <RibbonGroup label="Formato">
        <div class="ribbon-btn-stack">
          <div class="ribbon-btn-row">
            <RibbonButton icon={icons.bold} title="Negrita  \textbf{…}" onClick={() => wrap('\\textbf{', '}')} />
            <RibbonButton icon={icons.italic} title="Cursiva  \emph{…}" onClick={() => wrap('\\emph{', '}')} />
            <RibbonButton icon={icons.underline} title="Subrayado  \underline{…}" onClick={() => wrap('\\underline{', '}')} />
            <RibbonButton icon={icons.strike} title="Tachado  \sout{…} (ulem)" onClick={() => wrap('\\sout{', '}')} />
          </div>
          <div class="ribbon-btn-row">
            <RibbonButton icon={icons.sub} title="Subíndice  \textsubscript{…}" onClick={() => wrap('\\textsubscript{', '}')} />
            <RibbonButton icon={icons.sup} title="Superíndice  \textsuperscript{…}" onClick={() => wrap('\\textsuperscript{', '}')} />
            <RibbonDropdown compact label="Aa" title="Cambiar mayúsculas/minúsculas" items={CASE_OPTIONS} onPick={(it) => changeCase(it.mode)} />
          </div>
        </div>
      </RibbonGroup>

      <RibbonGroup label="Párrafo">
        <div class="ribbon-btn-stack">
          <div class="ribbon-btn-row">
            <RibbonButton icon={icons.alignLeft} title="Alinear a la izquierda" onClick={() => runSnippet(ALIGN[0])} />
            <RibbonButton icon={icons.alignCenter} title="Centrar" onClick={() => runSnippet(ALIGN[1])} />
            <RibbonButton icon={icons.alignRight} title="Alinear a la derecha" onClick={() => runSnippet(ALIGN[2])} />
          </div>
          <div class="ribbon-btn-row">
            <RibbonButton icon={icons.bullets} title="Lista de viñetas" onClick={() => runSnippet(LISTS[0])} />
            <RibbonButton icon={icons.numbered} title="Lista numerada" onClick={() => runSnippet(LISTS[1])} />
            <RibbonDropdown compact label="Listas" title="Listas y elementos" items={LISTS} onPick={runSnippet} />
          </div>
        </div>
      </RibbonGroup>

      <RibbonGroup label="Insertar">
        <RibbonButton icon={icons.table} label="Tabla" title="Asistente de tabla" onClick={openTableWizard} />
        <RibbonButton icon={icons.image} label="Imagen" title="Insertar imagen / figura" onClick={openFigureWizard} />
      </RibbonGroup>

      <RibbonGroup label="Tabla">
        <div class="ribbon-btn-stack">
          <div class="ribbon-btn-row">
            <RibbonButton icon={icons.tblAddRow} title="Añadir fila" onClick={tblAddRow} />
            <RibbonButton icon={icons.tblAddCol} title="Añadir columna" onClick={tblAddCol} />
            <RibbonButton icon={icons.tblHline} title="Línea horizontal (\hline)" onClick={tblHline} />
          </div>
          <div class="ribbon-btn-row">
            <RibbonButton icon={icons.tblDelRow} title="Eliminar fila" onClick={tblDelRow} />
            <RibbonButton icon={icons.tblDelCol} title="Eliminar columna" onClick={tblDelCol} />
            <RibbonButton icon={icons.tblAlign} title="Alinear columna (elige l/c/r en el menú de al lado)" onClick={() => tblAlign('c')} />
          </div>
        </div>
        <div class="ribbon-dd-row">
          <RibbonDropdown compact label="Alinear" title="Alinear la columna actual (izquierda/centro/derecha)"
            items={COL_ALIGN} onPick={(it) => tblAlign(it.a)} />
        </div>
      </RibbonGroup>

      <RibbonGroup label="Estructura">
        <div class="ribbon-dd-stack">
          <RibbonDropdown caption="Sección" title="Estructura del documento" items={STRUCTURE} onPick={runSnippet} />
          <RibbonDropdown caption="Etiqueta" title="Etiquetas y referencias" items={LABELS} onPick={runSnippet} />
          <RibbonDropdown caption="Tamaño" title="Tamaño de letra" items={FONT_SIZES} onPick={runSnippet} />
        </div>
      </RibbonGroup>
    </>
  );
}
