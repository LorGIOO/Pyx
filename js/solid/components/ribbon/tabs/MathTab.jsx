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
      <RibbonGroup label="Mode">
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.mInline} label="Inline  $…$" onClick={() => wrap('$', '$')} />
          <RibbonButton size="small" icon={icons.mInline} label="Inline  \(…\)" onClick={() => wrap('\\(', '\\)')} />
          <RibbonButton size="small" icon={icons.mDisplay} label="Display  \[…\]" onClick={() => wrap('\\[\n  ', '\n\\]')} />
        </div>
      </RibbonGroup>

      <RibbonGroup label="Basic">
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.mSub} label="Subscript  _{}" onClick={() => wrap('_{', '}')} />
          <RibbonButton size="small" icon={icons.mSup} label="Superscript  ^{}" onClick={() => wrap('^{', '}')} />
          <RibbonButton size="small" icon={icons.mSqrt} label="Root  √" onClick={() => wrap('\\sqrt{', '}')} />
        </div>
        <div class="ribbon-btn-stack">
          <RibbonButton size="small" icon={icons.mFrac} label="Fraction" onClick={() => insertSnippet('\\frac{}{}')} />
          <RibbonButton size="small" icon={icons.mFrac} label="dfrac" onClick={() => insertSnippet('\\dfrac{}{}')} />
          <RibbonButton size="small" icon={icons.mArray} label="array" onClick={() => insertSnippet(ARRAY)} />
        </div>
      </RibbonGroup>

      <RibbonGroup label="Delimiters">
        <div class="ribbon-dd-row">
          <RibbonDropdown compact label="(" title="Left delimiter (inserts \left…)" items={LEFT_DELIMS} onPick={runSnippet} />
          <RibbonDropdown compact label=")" title="Right delimiter (inserts \right…)" items={RIGHT_DELIMS} onPick={runSnippet} />
        </div>
      </RibbonGroup>

      <RibbonGroup label="Environments">
        <div class="ribbon-dd-stack">
          <RibbonDropdown caption="Equations" title="Equation environments" items={MATH_ENVIRONMENTS} onPick={runSnippet} />
          <RibbonDropdown caption="Definitions" title="Theorems and definitions" items={MATH_THEOREMS} onPick={runSnippet} />
        </div>
      </RibbonGroup>

      <RibbonGroup label="Symbols and styles">
        <div class="ribbon-dd-stack">
          <RibbonDropdown caption="Functions" title="Math functions (\sin, \log…)" items={MATH_FUNCTIONS} onPick={runSnippet} />
          <RibbonDropdown caption="Styles" title="Math font styles" items={MATH_FONTS} onPick={runSnippet} />
          <RibbonDropdown caption="Operators" title="Large operators with limits (∑ ∏ ∫)" items={MATH_STACK} onPick={runSnippet} />
        </div>
        <div class="ribbon-dd-stack">
          {/* "Stacked" = over/under constructs — NOT the side-panel symbols. */}
          <RibbonDropdown caption="Stacked" title="Stackable symbols: over/under, braces, arrows…" items={MATH_OVERUNDER} onPick={runSnippet} />
          <RibbonDropdown caption="Accents" title="Math accents" items={MATH_ACCENTS} onPick={runSnippet} />
        </div>
        <div class="ribbon-dd-stack">
          <RibbonDropdown caption="Space ↔" title="Horizontal spacing" items={HSPACES} onPick={runSnippet} />
          <RibbonDropdown caption="Space ↕" title="Vertical spacing and breaks" items={VSPACES} onPick={runSnippet} />
        </div>
      </RibbonGroup>
    </>
  );
}
