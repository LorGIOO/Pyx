import RibbonGroup from '../RibbonGroup.jsx';
import RibbonButton from '../RibbonButton.jsx';
import RibbonDropdown from '../RibbonDropdown.jsx';
import { icons } from '../icons.js';
import { t } from '../../../../core/i18n.js';
import { wrap, insertSnippet } from '../../../../editor/commands.js';
import {
  runSnippet, LEFT_DELIMS, RIGHT_DELIMS,
  MATH_ENVIRONMENTS, MATH_FUNCTIONS, MATH_THEOREMS, MATH_FONTS, MATH_STACK, MATH_ACCENTS,
  MATH_OVERUNDER, HSPACES, VSPACES,
} from '../../../../data/latex-snippets.js';

const ARRAY = '\\begin{array}{cc}\n   & \\\\\n   & \n\\end{array}';

export default function MathTab() {
  return (
    <>
      <RibbonGroup label={t('Modo', 'Mode')}>
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.mInline} label={t('En línea', 'Inline') + '  $…$'} onClick={() => wrap('$', '$')} />
          <RibbonButton size="small" icon={icons.mInline} label={t('En línea', 'Inline') + '  \\(…\\)'} onClick={() => wrap('\\(', '\\)')} />
          <RibbonButton size="small" icon={icons.mDisplay} label={t('Independiente', 'Display') + '  \\[…\\]'} onClick={() => wrap('\\[\n  ', '\n\\]')} />
        </div>
      </RibbonGroup>

      <RibbonGroup label={t('Básico', 'Basic')}>
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.mSub} label={t('Subíndice', 'Subscript') + '  _{}'} onClick={() => wrap('_{', '}')} />
          <RibbonButton size="small" icon={icons.mSup} label={t('Superíndice', 'Superscript') + '  ^{}'} onClick={() => wrap('^{', '}')} />
          <RibbonButton size="small" icon={icons.mSqrt} label={t('Raíz', 'Root') + '  √'} onClick={() => wrap('\\sqrt{', '}')} />
        </div>
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.mFrac} label={t('Fracción', 'Fraction')} onClick={() => insertSnippet('\\frac{}{}')} />
          <RibbonButton size="small" icon={icons.mFrac} label="dfrac" onClick={() => insertSnippet('\\dfrac{}{}')} />
          <RibbonButton size="small" icon={icons.mArray} label="array" onClick={() => insertSnippet(ARRAY)} />
        </div>
      </RibbonGroup>

      <RibbonGroup label={t('Delimitadores', 'Delimiters')}>
        <div class="ribbon-dd-row">
          <RibbonDropdown compact label="(" title={t('Delimitador izquierdo (inserta \\left…)', 'Left delimiter (inserts \\left…)')} items={LEFT_DELIMS()} onPick={runSnippet} />
          <RibbonDropdown compact label=")" title={t('Delimitador derecho (inserta \\right…)', 'Right delimiter (inserts \\right…)')} items={RIGHT_DELIMS()} onPick={runSnippet} />
        </div>
      </RibbonGroup>

      <RibbonGroup label={t('Entornos', 'Environments')}>
        <div class="ribbon-dd-stack">
          <RibbonDropdown caption={t('Ecuaciones', 'Equations')} title={t('Entornos de ecuación', 'Equation environments')} items={MATH_ENVIRONMENTS()} onPick={runSnippet} />
          <RibbonDropdown caption={t('Definiciones', 'Definitions')} title={t('Teoremas y definiciones', 'Theorems and definitions')} items={MATH_THEOREMS()} onPick={runSnippet} />
        </div>
      </RibbonGroup>

      <RibbonGroup label={t('Símbolos y estilos', 'Symbols and styles')}>
        <div class="ribbon-dd-stack">
          <RibbonDropdown caption={t('Funciones', 'Functions')} title={t('Funciones matemáticas (\\sin, \\log…)', 'Math functions (\\sin, \\log…)')} items={MATH_FUNCTIONS()} onPick={runSnippet} />
          <RibbonDropdown caption={t('Estilos', 'Styles')} title={t('Estilos de letra matemáticos', 'Math font styles')} items={MATH_FONTS()} onPick={runSnippet} />
          <RibbonDropdown caption={t('Operadores', 'Operators')} title={t('Operadores grandes con límites (∑ ∏ ∫)', 'Large operators with limits (∑ ∏ ∫)')} items={MATH_STACK()} onPick={runSnippet} />
        </div>
        <div class="ribbon-dd-stack">
          {/* "Stacked" = over/under constructs — NOT the side-panel symbols. */}
          <RibbonDropdown caption={t('Apilados', 'Stacked')} title={t('Símbolos apilables: sobre/bajo, llaves, flechas…', 'Stackable symbols: over/under, braces, arrows…')} items={MATH_OVERUNDER()} onPick={runSnippet} />
          <RibbonDropdown caption={t('Acentos', 'Accents')} title={t('Acentos matemáticos', 'Math accents')} items={MATH_ACCENTS()} onPick={runSnippet} />
        </div>
        <div class="ribbon-dd-stack">
          <RibbonDropdown caption={t('Espacio ↔', 'Space ↔')} title={t('Espaciado horizontal', 'Horizontal spacing')} items={HSPACES()} onPick={runSnippet} />
          <RibbonDropdown caption={t('Espacio ↕', 'Space ↕')} title={t('Espaciado vertical y saltos', 'Vertical spacing and breaks')} items={VSPACES()} onPick={runSnippet} />
        </div>
      </RibbonGroup>
    </>
  );
}
