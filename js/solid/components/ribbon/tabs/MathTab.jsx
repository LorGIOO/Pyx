import RibbonGroup from '../RibbonGroup.jsx';
import RibbonButton from '../RibbonButton.jsx';
import RibbonDropdown from '../RibbonDropdown.jsx';
import { icons } from '../icons.js';
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
      <RibbonGroup label="Modo">
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.mInline} label="En línea  $…$" onClick={() => wrap('$', '$')} />
          <RibbonButton size="small" icon={icons.mInline} label="En línea  \(…\)" onClick={() => wrap('\\(', '\\)')} />
          <RibbonButton size="small" icon={icons.mDisplay} label="Independiente  \[…\]" onClick={() => wrap('\\[\n  ', '\n\\]')} />
        </div>
      </RibbonGroup>

      <RibbonGroup label="Básico">
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.mSub} label="Subíndice  _{}" onClick={() => wrap('_{', '}')} />
          <RibbonButton size="small" icon={icons.mSup} label="Superíndice  ^{}" onClick={() => wrap('^{', '}')} />
          <RibbonButton size="small" icon={icons.mSqrt} label="Raíz  √" onClick={() => wrap('\\sqrt{', '}')} />
        </div>
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.mFrac} label="Fracción" onClick={() => insertSnippet('\\frac{}{}')} />
          <RibbonButton size="small" icon={icons.mFrac} label="dfrac" onClick={() => insertSnippet('\\dfrac{}{}')} />
          <RibbonButton size="small" icon={icons.mArray} label="array" onClick={() => insertSnippet(ARRAY)} />
        </div>
      </RibbonGroup>

      <RibbonGroup label="Delimitadores">
        <div class="ribbon-dd-row">
          <RibbonDropdown compact label="(" title="Delimitador izquierdo (inserta \left…)" items={LEFT_DELIMS} onPick={runSnippet} />
          <RibbonDropdown compact label=")" title="Delimitador derecho (inserta \right…)" items={RIGHT_DELIMS} onPick={runSnippet} />
        </div>
      </RibbonGroup>

      <RibbonGroup label="Entornos">
        <div class="ribbon-dd-stack">
          <RibbonDropdown caption="Ecuaciones" title="Entornos de ecuación" items={MATH_ENVIRONMENTS} onPick={runSnippet} />
          <RibbonDropdown caption="Definiciones" title="Teoremas y definiciones" items={MATH_THEOREMS} onPick={runSnippet} />
        </div>
      </RibbonGroup>

      <RibbonGroup label="Símbolos y estilos">
        <div class="ribbon-dd-stack">
          <RibbonDropdown caption="Funciones" title="Funciones matemáticas (\sin, \log…)" items={MATH_FUNCTIONS} onPick={runSnippet} />
          <RibbonDropdown caption="Estilos" title="Estilos de letra matemáticos" items={MATH_FONTS} onPick={runSnippet} />
          <RibbonDropdown caption="Operadores" title="Operadores grandes con límites (∑ ∏ ∫)" items={MATH_STACK} onPick={runSnippet} />
        </div>
        <div class="ribbon-dd-stack">
          {/* "Apilados" = over/under constructs — NOT the side-panel symbols. */}
          <RibbonDropdown caption="Apilados" title="Símbolos apilables: sobre/bajo, llaves, flechas…" items={MATH_OVERUNDER} onPick={runSnippet} />
          <RibbonDropdown caption="Acentos" title="Acentos matemáticos" items={MATH_ACCENTS} onPick={runSnippet} />
        </div>
        <div class="ribbon-dd-stack">
          <RibbonDropdown caption="Espacio ↔" title="Espaciado horizontal" items={HSPACES} onPick={runSnippet} />
          <RibbonDropdown caption="Espacio ↕" title="Espaciado vertical y saltos" items={VSPACES} onPick={runSnippet} />
        </div>
      </RibbonGroup>
    </>
  );
}
