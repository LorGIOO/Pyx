import RibbonGroup from '../RibbonGroup.jsx';
import RibbonButton from '../RibbonButton.jsx';
import RibbonDropdown from '../RibbonDropdown.jsx';
import { icons } from '../icons.js';
import { state } from '../../../../core/state.js';
import { t } from '../../../../core/i18n.js';
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

// "Aa" change-case menu (Word-style). Factory so labels follow the language.
const CASE_OPTIONS = () => [
  { label: t('MAYÚSCULAS', 'UPPERCASE'), sym: 'AA', hint: 'UPPER', mode: 'upper' },
  { label: t('minúsculas', 'lowercase'), sym: 'aa', hint: 'lower', mode: 'lower' },
  { label: t('Tipo oración (solo la inicial)', 'Sentence case (first letter only)'), sym: 'Ab', hint: 'Sentence', mode: 'sentence' },
  { label: t('Cada Palabra En Mayúscula', 'Capitalize Each Word'), sym: 'Tt', hint: 'Title', mode: 'title' },
  { label: t('aLTERNAR mAYÚS/minús', 'tOGGLE cASE'), sym: 'aA', hint: 'tOGGLE', mode: 'toggle' },
];

// Column-alignment menu (TeXstudio's "align column" — sets the spec to l/c/r).
const COL_ALIGN = () => [
  { label: t('Izquierda', 'Left'), badge: 'l', a: 'l' },
  { label: t('Centrada', 'Center'), badge: 'c', a: 'c' },
  { label: t('Derecha', 'Right'), badge: 'r', a: 'r' },
];

export default function HomeTab() {
  const hasDoc = () => state.documents.length > 0;
  const busy = () => !hasDoc() || state.compiling;
  const showPreview = () => { state.previewVisible = true; rerender(); };

  return (
    <>
      <RibbonGroup label={t('Portapapeles', 'Clipboard')}>
        <RibbonButton icon={icons.paste} label={t('Pegar', 'Paste')} onClick={() => clip('paste')} />
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.cut} label={t('Cortar', 'Cut')} onClick={() => clip('cut')} />
          <RibbonButton size="small" icon={icons.copy} label={t('Copiar', 'Copy')} onClick={() => clip('copy')} />
          <RibbonButton size="small" icon={icons.find} label={t('Buscar', 'Find')} onClick={openFind} />
        </div>
      </RibbonGroup>

      <RibbonGroup label={t('Compilación', 'Compile')}>
        <RibbonButton icon={icons.compile} label={t('Compilar y ver', 'Compile & view')} disabled={busy()}
          title={`${t('Compilar y ver el PDF', 'Compile and view the PDF')}${comboOf('compile.run') ? ` (${comboOf('compile.run')})` : ''}`}
          onClick={() => compileActive(true)} />
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.pdf} label={t('Compilar', 'Compile')} disabled={busy()}
            title={t('Compilar en segundo plano (sin abrir el visor)', 'Compile in the background (without opening the viewer)')} onClick={() => compileActive(false)} />
          <RibbonButton size="small" icon={icons.preview} label={t('Visualizar', 'View')} disabled={!hasDoc()} onClick={showPreview} />
          <RibbonButton size="small" icon={icons.live} label={t('Al escribir', 'On type')} active={state.liveCompile}
            title={t('Compilación automática al dejar de escribir (no bloquea el editor)', "Auto-compile when you stop typing (doesn't block the editor)")}
            onClick={() => { state.liveCompile = !state.liveCompile; setGeneral({ liveCompile: state.liveCompile }); }} />
        </div>
      </RibbonGroup>

      <RibbonGroup label={t('Formato', 'Format')}>
        <div class="ribbon-btn-stack">
          <div class="ribbon-btn-row">
            <RibbonButton icon={icons.bold} title={t('Negrita', 'Bold') + '  \\textbf{…}'} onClick={() => wrap('\\textbf{', '}')} />
            <RibbonButton icon={icons.italic} title={t('Cursiva', 'Italic') + '  \\emph{…}'} onClick={() => wrap('\\emph{', '}')} />
            <RibbonButton icon={icons.underline} title={t('Subrayado', 'Underline') + '  \\underline{…}'} onClick={() => wrap('\\underline{', '}')} />
            <RibbonButton icon={icons.strike} title={t('Tachado', 'Strikethrough') + '  \\sout{…} (ulem)'} onClick={() => wrap('\\sout{', '}')} />
          </div>
          <div class="ribbon-btn-row">
            <RibbonButton icon={icons.sub} title={t('Subíndice', 'Subscript') + '  \\textsubscript{…}'} onClick={() => wrap('\\textsubscript{', '}')} />
            <RibbonButton icon={icons.sup} title={t('Superíndice', 'Superscript') + '  \\textsuperscript{…}'} onClick={() => wrap('\\textsuperscript{', '}')} />
            <RibbonDropdown compact label="Aa" title={t('Cambiar mayúsculas/minúsculas', 'Change case')} items={CASE_OPTIONS()} onPick={(it) => changeCase(it.mode)} />
          </div>
        </div>
      </RibbonGroup>

      <RibbonGroup label={t('Párrafo', 'Paragraph')}>
        <div class="ribbon-btn-stack">
          <div class="ribbon-btn-row">
            <RibbonButton icon={icons.alignLeft} title={t('Alinear a la izquierda', 'Align left')} onClick={() => runSnippet(ALIGN[0])} />
            <RibbonButton icon={icons.alignCenter} title={t('Centrar', 'Center')} onClick={() => runSnippet(ALIGN[1])} />
            <RibbonButton icon={icons.alignRight} title={t('Alinear a la derecha', 'Align right')} onClick={() => runSnippet(ALIGN[2])} />
          </div>
          <div class="ribbon-btn-row">
            <RibbonButton icon={icons.bullets} title={t('Lista de viñetas', 'Bulleted list')} onClick={() => runSnippet(LISTS[0])} />
            <RibbonButton icon={icons.numbered} title={t('Lista numerada', 'Numbered list')} onClick={() => runSnippet(LISTS[1])} />
            <RibbonDropdown compact label={t('Listas', 'Lists')} title={t('Listas y elementos', 'Lists and items')} items={LISTS} onPick={runSnippet} />
          </div>
        </div>
      </RibbonGroup>

      <RibbonGroup label={t('Insertar', 'Insert')}>
        <RibbonButton icon={icons.table} label={t('Tabla', 'Table')} title={t('Asistente de tabla', 'Table wizard')} onClick={openTableWizard} />
        <RibbonButton icon={icons.image} label={t('Imagen', 'Image')} title={t('Insertar imagen / figura', 'Insert image / figure')} onClick={openFigureWizard} />
      </RibbonGroup>

      <RibbonGroup label={t('Tabla', 'Table')}>
        <div class="ribbon-btn-stack">
          <div class="ribbon-btn-row">
            <RibbonButton icon={icons.tblAddRow} title={t('Añadir fila', 'Add row')} onClick={tblAddRow} />
            <RibbonButton icon={icons.tblAddCol} title={t('Añadir columna', 'Add column')} onClick={tblAddCol} />
            <RibbonButton icon={icons.tblHline} title={t('Línea horizontal', 'Horizontal line') + ' (\\hline)'} onClick={tblHline} />
          </div>
          <div class="ribbon-btn-row">
            <RibbonButton icon={icons.tblDelRow} title={t('Eliminar fila', 'Delete row')} onClick={tblDelRow} />
            <RibbonButton icon={icons.tblDelCol} title={t('Eliminar columna', 'Delete column')} onClick={tblDelCol} />
            <RibbonButton icon={icons.tblAlign} title={t('Alinear columna (elige l/c/r en el menú de al lado)', 'Align column (choose l/c/r in the adjacent menu)')} onClick={() => tblAlign('c')} />
          </div>
        </div>
        <div class="ribbon-dd-row">
          <RibbonDropdown compact label={t('Alinear', 'Align')} title={t('Alinear la columna actual (izquierda/centro/derecha)', 'Align the current column (left/center/right)')}
            items={COL_ALIGN()} onPick={(it) => tblAlign(it.a)} />
        </div>
      </RibbonGroup>

      <RibbonGroup label={t('Estructura', 'Structure')}>
        <div class="ribbon-dd-stack">
          <RibbonDropdown caption={t('Sección', 'Section')} title={t('Estructura del documento', 'Document structure')} items={STRUCTURE} onPick={runSnippet} />
          <RibbonDropdown caption={t('Etiqueta', 'Label')} title={t('Etiquetas y referencias', 'Labels and references')} items={LABELS} onPick={runSnippet} />
          <RibbonDropdown caption={t('Tamaño', 'Size')} title={t('Tamaño de letra', 'Font size')} items={FONT_SIZES} onPick={runSnippet} />
        </div>
      </RibbonGroup>
    </>
  );
}
