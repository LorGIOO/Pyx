// Data for the Home-tab toolbar dropdowns (TeXstudio-style).
// Each item: { label, hint?, wrap?: [before, after], ins?: text }.
//  - wrap  → wraps the current selection (cursor lands inside if empty)
//  - ins   → inserts the literal text at the cursor
//
// Every list is a FACTORY (a function returning the array) so the labels follow
// the active UI language (see core/i18n.js): consumers call e.g. STRUCTURE().
// `hint` values are LaTeX commands and stay untranslated.

import { wrap, insertSnippet } from '../editor/commands.js';
import { t } from '../core/i18n.js';

export function runSnippet(item) {
  if (item.wrap) wrap(item.wrap[0], item.wrap[1]);
  else if (item.ins != null) insertSnippet(item.ins);
}

// Sectioning, like TeXstudio's structure toolbar (incl. starred forms). Each
// item shows a level badge (Pt · Cap · S1/S2/S3 · ¶) so the hierarchy is
// visible at a glance.
export const STRUCTURE = () => [
  { label: t('Parte', 'Part'), badge: 'Pt', hint: '\\part', wrap: ['\\part{', '}'] },
  { label: t('Capítulo', 'Chapter'), badge: 'Cap', hint: '\\chapter', wrap: ['\\chapter{', '}'] },
  { label: t('Sección', 'Section'), badge: 'S1', hint: '\\section', wrap: ['\\section{', '}'] },
  { label: t('Subsección', 'Subsection'), badge: 'S2', hint: '\\subsection', wrap: ['\\subsection{', '}'] },
  { label: t('Subsubsección', 'Subsubsection'), badge: 'S3', hint: '\\subsubsection', wrap: ['\\subsubsection{', '}'] },
  { label: t('Párrafo', 'Paragraph'), badge: '¶', hint: '\\paragraph', wrap: ['\\paragraph{', '}'] },
  { label: t('Subpárrafo', 'Subparagraph'), badge: '¶¶', hint: '\\subparagraph', wrap: ['\\subparagraph{', '}'] },
  { label: t('Parte*', 'Part*'), badge: 'Pt', hint: '\\part*', wrap: ['\\part*{', '}'] },
  { label: t('Capítulo*', 'Chapter*'), badge: 'Cap', hint: '\\chapter*', wrap: ['\\chapter*{', '}'] },
  { label: t('Sección*', 'Section*'), badge: 'S1', hint: '\\section*', wrap: ['\\section*{', '}'] },
  { label: t('Subsección*', 'Subsection*'), badge: 'S2', hint: '\\subsection*', wrap: ['\\subsection*{', '}'] },
  { label: t('Subsubsección*', 'Subsubsection*'), badge: 'S3', hint: '\\subsubsection*', wrap: ['\\subsubsection*{', '}'] },
];

// LaTeX font sizes, named like TeXstudio. The badge is an "A" rendered AT the
// relative size, so the menu previews each size visually.
const sizeBadge = (px) => ({ badge: 'A', badgeStyle: { 'font-size': px + 'px' } });
export const FONT_SIZES = () => [
  { label: t('Enana', 'Tiny'), hint: '\\tiny', ...sizeBadge(8), wrap: ['{\\tiny ', '}'] },
  { label: t('Tamaño índices', 'Script size'), hint: '\\scriptsize', ...sizeBadge(9), wrap: ['{\\scriptsize ', '}'] },
  { label: t('Tamaño nota al pie', 'Footnote size'), hint: '\\footnotesize', ...sizeBadge(10), wrap: ['{\\footnotesize ', '}'] },
  { label: t('Pequeña', 'Small'), hint: '\\small', ...sizeBadge(11), wrap: ['{\\small ', '}'] },
  { label: t('Tamaño normal', 'Normal size'), hint: '\\normalsize', ...sizeBadge(12), wrap: ['{\\normalsize ', '}'] },
  { label: t('grande', 'large'), hint: '\\large', ...sizeBadge(13), wrap: ['{\\large ', '}'] },
  { label: t('Grande', 'Large'), hint: '\\Large', ...sizeBadge(14), wrap: ['{\\Large ', '}'] },
  { label: t('GRANDE', 'LARGE'), hint: '\\LARGE', ...sizeBadge(15), wrap: ['{\\LARGE ', '}'] },
  { label: t('enorme', 'huge'), hint: '\\huge', ...sizeBadge(16), wrap: ['{\\huge ', '}'] },
  { label: t('Enorme', 'Huge'), hint: '\\Huge', ...sizeBadge(17), wrap: ['{\\Huge ', '}'] },
];

// Labels / references, like TeXstudio's label toolbar.
export const LABELS = () => [
  { label: t('Etiqueta', 'Label'), sym: '⚓', hint: '\\label', wrap: ['\\label{', '}'] },
  { label: 'ref', sym: '#', hint: '\\ref', wrap: ['\\ref{', '}'] },
  { label: 'eqref', sym: '#', hint: '\\eqref', wrap: ['\\eqref{', '}'] },
  { label: 'pageref', sym: '¶', hint: '\\pageref', wrap: ['\\pageref{', '}'] },
  { label: t('Índice', 'Index'), sym: '☰', hint: '\\index', wrap: ['\\index{', '}'] },
  { label: t('cita', 'cite'), sym: '❝', hint: '\\cite', wrap: ['\\cite{', '}'] },
  { label: t('Nota al pie', 'Footnote'), sym: '†', hint: '\\footnote', wrap: ['\\footnote{', '}'] },
];

// Opening / left delimiters (used with \left). The menu shows the VISUAL
// symbol; the LaTeX it inserts appears as the hint (and is what reaches the
// document) — TeXstudio-style, but friendlier to read.
export const LEFT_DELIMS = () => [
  { label: '(', hint: '\\left(', ins: '\\left( ' },
  { label: '[', hint: '\\left[', ins: '\\left[ ' },
  { label: '{', hint: '\\left\\{', ins: '\\left\\{ ' },
  { label: '⟨', hint: '\\left\\langle', ins: '\\left\\langle ' },
  { label: ')', hint: '\\left)', ins: '\\left) ' },
  { label: ']', hint: '\\left]', ins: '\\left] ' },
  { label: '}', hint: '\\left\\}', ins: '\\left\\} ' },
  { label: '|', hint: '\\left|', ins: '\\left| ' },
  { label: '‖', hint: '\\left\\|', ins: '\\left\\| ' },
  { label: '.', hint: t('\\left. (invisible)', '\\left. (invisible)'), ins: '\\left. ' },
  { label: '⌊', hint: '\\left\\lfloor', ins: '\\left\\lfloor ' },
  { label: '⌈', hint: '\\left\\lceil', ins: '\\left\\lceil ' },
];

// ---- Math tab data ----

// Display/equation environments (amsmath), like TeXstudio's "Equations".
export const MATH_ENVIRONMENTS = () => [
  { label: 'equation', sym: '=', hint: 'amsmath', wrap: ['\\begin{equation}\n  ', '\n\\end{equation}'] },
  { label: 'align', sym: '⫶', hint: 'amsmath', wrap: ['\\begin{align}\n  ', '\n\\end{align}'] },
  { label: 'alignat', sym: '⫶', hint: 'amsmath', wrap: ['\\begin{alignat}{2}\n  ', '\n\\end{alignat}'] },
  { label: 'flalign', sym: '⫶', hint: 'amsmath', wrap: ['\\begin{flalign}\n  ', '\n\\end{flalign}'] },
  { label: 'gather', sym: '≡', hint: 'amsmath', wrap: ['\\begin{gather}\n  ', '\n\\end{gather}'] },
  { label: 'multline', sym: '≣', hint: 'amsmath', wrap: ['\\begin{multline}\n  ', '\n\\end{multline}'] },
  { label: 'equation*', sym: '=', hint: 'amsmath', wrap: ['\\begin{equation*}\n  ', '\n\\end{equation*}'] },
  { label: 'align*', sym: '⫶', hint: 'amsmath', wrap: ['\\begin{align*}\n  ', '\n\\end{align*}'] },
  { label: 'alignat*', sym: '⫶', hint: 'amsmath', wrap: ['\\begin{alignat*}{2}\n  ', '\n\\end{alignat*}'] },
  { label: 'flalign*', sym: '⫶', hint: 'amsmath', wrap: ['\\begin{flalign*}\n  ', '\n\\end{flalign*}'] },
  { label: 'gather*', sym: '≡', hint: 'amsmath', wrap: ['\\begin{gather*}\n  ', '\n\\end{gather*}'] },
  { label: 'multline*', sym: '≣', hint: 'amsmath', wrap: ['\\begin{multline*}\n  ', '\n\\end{multline*}'] },
  { label: 'cases', sym: '{', hint: 'amsmath', wrap: ['\\begin{cases}\n  ', '\n\\end{cases}'] },
  { label: 'split', sym: '⌇', hint: 'amsmath', wrap: ['\\begin{split}\n  ', '\n\\end{split}'] },
];

// Math operator names.
export const MATH_FUNCTIONS = () => ['arccos', 'arcsin', 'arctan', 'arg', 'cos', 'cosh', 'cot', 'coth',
  'csc', 'deg', 'det', 'dim', 'exp', 'gcd', 'hom', 'inf', 'ker', 'lg', 'lim', 'liminf', 'limsup',
  'ln', 'log', 'max', 'min', 'sec', 'sin', 'sinh', 'sup', 'tan', 'tanh', 'Pr']
  .map((f) => ({ label: '\\' + f, sym: 'ƒ', ins: '\\' + f + ' ' }));

// Theorem-like environments (ntheorem / amsthm).
export const MATH_THEOREMS = () => [
  ['Corollary', 'corollary'], ['Definition', 'definition'], ['Example', 'example'],
  ['Lemma', 'lemma'], ['Proof', 'proof'], ['Proposition', 'proposition'],
  ['Remark', 'remark'], ['Theorem', 'theorem'],
].map(([label, env]) => {
  const THM_SYM = {
    theorem: '⊢', lemma: '⊩', corollary: '⇒', proposition: '∴',
    definition: '≝', proof: '∎', example: '✎', remark: '✦',
  };
  return { label, sym: THM_SYM[env] || '§', hint: env, wrap: ['\\begin{' + env + '}\n  ', '\n\\end{' + env + '}'] };
});

// Math font styles. The symbol previews the actual style (Unicode math glyphs).
export const MATH_FONTS = () => [
  { label: t('Romana', 'Roman'), sym: 'A', hint: '\\mathrm', wrap: ['\\mathrm{', '}'] },
  { label: t('Itálica', 'Italic'), sym: '𝐴', hint: '\\mathit', wrap: ['\\mathit{', '}'] },
  { label: t('Negrita', 'Bold'), sym: '𝐀', hint: '\\mathbf', wrap: ['\\mathbf{', '}'] },
  { label: 'Sans Serif', sym: '𝖠', hint: '\\mathsf', wrap: ['\\mathsf{', '}'] },
  { label: t('Máquina de escribir', 'Typewriter'), sym: '𝙰', hint: '\\mathtt', wrap: ['\\mathtt{', '}'] },
  { label: t('Caligráfica', 'Calligraphic'), sym: '𝒜', hint: '\\mathcal', wrap: ['\\mathcal{', '}'] },
  { label: t('Pizarra (amssymb)', 'Blackboard (amssymb)'), sym: '𝔸', hint: '\\mathbb', wrap: ['\\mathbb{', '}'] },
  { label: 'Fraktur (amssymb)', sym: '𝔄', hint: '\\mathfrak', wrap: ['\\mathfrak{', '}'] },
];

// Stackable operators (sub/superscript limits).
export const MATH_STACK = () => [
  { label: t('Sumatorio', 'Sum'), sym: '∑', hint: '\\sum', ins: '\\sum_{}^{}' },
  { label: t('Productorio', 'Product'), sym: '∏', hint: '\\prod', ins: '\\prod_{}^{}' },
  { label: t('Coproducto', 'Coproduct'), sym: '∐', hint: '\\coprod', ins: '\\coprod_{}^{}' },
  { label: t('Integral', 'Integral'), sym: '∫', hint: '\\int', ins: '\\int_{}^{}' },
  { label: t('Integral doble', 'Double integral'), sym: '∬', hint: '\\iint', ins: '\\iint_{}^{}' },
  { label: t('Integral curvilínea', 'Contour integral'), sym: '∮', hint: '\\oint', ins: '\\oint_{}^{}' },
  { label: t('Unión', 'Union'), sym: '⋃', hint: '\\bigcup', ins: '\\bigcup_{}^{}' },
  { label: t('Intersección', 'Intersection'), sym: '⋂', hint: '\\bigcap', ins: '\\bigcap_{}^{}' },
  { label: t('Límite', 'Limit'), sym: 'lim', hint: '\\lim', ins: '\\lim_{}' },
  { label: t('Máximo', 'Maximum'), sym: 'max', hint: '\\max', ins: '\\max_{}' },
  { label: t('Mínimo', 'Minimum'), sym: 'min', hint: '\\min', ins: '\\min_{}' },
  { label: t('Suma directa', 'Direct sum'), sym: '⨁', hint: '\\bigoplus', ins: '\\bigoplus_{}^{}' },
  { label: t('Producto tensorial', 'Tensor product'), sym: '⨂', hint: '\\bigotimes', ins: '\\bigotimes_{}^{}' },
];

// Math accents (pure accents — over/under constructs live in MATH_OVERUNDER to
// avoid duplication).
export const MATH_ACCENTS = () => [
  { label: t('Sombrero', 'Hat'), sym: 'x̂', hint: '\\hat', wrap: ['\\hat{', '}'] },
  { label: t('Tilde', 'Tilde'), sym: 'x̃', hint: '\\tilde', wrap: ['\\tilde{', '}'] },
  { label: t('Barra', 'Bar'), sym: 'x̄', hint: '\\bar', wrap: ['\\bar{', '}'] },
  { label: t('Vector', 'Vector'), sym: 'x⃗', hint: '\\vec', wrap: ['\\vec{', '}'] },
  { label: t('Punto', 'Dot'), sym: 'ẋ', hint: '\\dot', wrap: ['\\dot{', '}'] },
  { label: t('Doble punto', 'Double dot'), sym: 'ẍ', hint: '\\ddot', wrap: ['\\ddot{', '}'] },
  { label: t('Sombrero ancho', 'Wide hat'), sym: 'x͆', hint: '\\widehat', wrap: ['\\widehat{', '}'] },
  { label: t('Tilde ancha', 'Wide tilde'), sym: 'x̃', hint: '\\widetilde', wrap: ['\\widetilde{', '}'] },
  { label: t('Breve', 'Breve'), sym: 'x̆', hint: '\\breve', wrap: ['\\breve{', '}'] },
  { label: t('Check', 'Check'), sym: 'x̌', hint: '\\check', wrap: ['\\check{', '}'] },
  { label: t('Agudo', 'Acute'), sym: 'x́', hint: '\\acute', wrap: ['\\acute{', '}'] },
  { label: t('Grave', 'Grave'), sym: 'x̀', hint: '\\grave', wrap: ['\\grave{', '}'] },
];

// HORIZONTAL spacing (↔) — exactly TeXstudio's "Horizontal spacing" set.
export const HSPACES = () => [
  { label: t('Espacio', 'Space'), sym: '␣', hint: '\\space', ins: '\\space ' },
  { label: t('Medio cuadratín', 'En space'), sym: '⸱', hint: '\\enspace', ins: '\\enspace ' },
  { label: t('Cuad  (1 em)', 'Quad  (1 em)'), sym: '▯', hint: '\\quad', ins: '\\quad ' },
  { label: t('Doble cuad  (2 em)', 'Double quad  (2 em)'), sym: '▭', hint: '\\qquad', ins: '\\qquad ' },
  { label: t('Fino', 'Thin'), sym: '‧', hint: '\\thinspace', ins: '\\thinspace ' },
  { label: t('Fino negativo', 'Negative thin'), sym: '⨪', hint: '\\negthinspace', ins: '\\negthinspace ' },
  { label: t('A medida', 'Custom'), sym: '↔', hint: '\\hspace', wrap: ['\\hspace{', '}'] },
  { label: t('Relleno', 'Fill'), sym: '⇥', hint: '\\hfill', ins: '\\hfill ' },
  { label: t('Relleno con línea', 'Rule fill'), sym: '—', hint: '\\hrulefill', ins: '\\hrulefill ' },
  { label: t('Relleno con puntos', 'Dot fill'), sym: '⋯', hint: '\\dotfill', ins: '\\dotfill ' },
];

// VERTICAL spacing + breaks (↕) — TeXstudio's "Vertical spacing" set.
export const VSPACES = () => [
  { label: t('Nueva página', 'New page'), sym: '⤓', hint: '\\newpage', ins: '\\newpage\n' },
  { label: t('Salto de línea', 'Line break'), sym: '↵', hint: '\\linebreak', ins: '\\linebreak\n' },
  { label: t('Salto de página', 'Page break'), sym: '⤵', hint: '\\pagebreak', ins: '\\pagebreak\n' },
  { label: t('Salto grande', 'Big skip'), sym: '⇕', hint: '\\bigskip', ins: '\\bigskip\n' },
  { label: t('Salto medio', 'Medium skip'), sym: '↕', hint: '\\medskip', ins: '\\medskip\n' },
  { label: t('Salto pequeño', 'Small skip'), sym: '˅', hint: '\\smallskip', ins: '\\smallskip\n' },
  { label: t('A medida', 'Custom'), sym: '↕', hint: '\\vspace', wrap: ['\\vspace{', '}'] },
  { label: t('Relleno', 'Fill'), sym: '⤓', hint: '\\vfill', ins: '\\vfill\n' },
  { label: t('Salto de línea  (Ctrl+Retorno)', 'Line break  (Ctrl+Enter)'), sym: '↵', hint: '\\\\', ins: '\\\\\n' },
];

// Over/under (stacked) math constructs — TeXstudio's stackable symbols. These
// are NOT in the side-panel symbol palette, so there is no redundancy.
export const MATH_OVERUNDER = () => [
  { label: t('Línea encima', 'Overline'), sym: 'x̅', hint: '\\overline', wrap: ['\\overline{', '}'] },
  { label: t('Línea debajo', 'Underline'), sym: 'x̲', hint: '\\underline', wrap: ['\\underline{', '}'] },
  { label: t('Llave encima', 'Overbrace'), sym: '⏞', hint: '\\overbrace', wrap: ['\\overbrace{', '}'] },
  { label: t('Llave debajo', 'Underbrace'), sym: '⏟', hint: '\\underbrace', wrap: ['\\underbrace{', '}'] },
  { label: t('Flecha izq. encima', 'Left arrow above'), sym: 'x⃖', hint: '\\overleftarrow', wrap: ['\\overleftarrow{', '}'] },
  { label: t('Flecha der. encima', 'Right arrow above'), sym: 'x⃗', hint: '\\overrightarrow', wrap: ['\\overrightarrow{', '}'] },
  { label: t('Apilar relación', 'Stack relation'), sym: '≜', hint: '\\stackrel', ins: '\\stackrel{}{}' },
  { label: t('Encima de', 'Overset'), sym: '⊤', hint: '\\overset (amsmath)', ins: '\\overset{}{}' },
  { label: t('Debajo de', 'Underset'), sym: '⊥', hint: '\\underset (amsmath)', ins: '\\underset{}{}' },
  { label: t('Índices laterales', 'Side indices'), sym: '⋊', hint: '\\sideset (amsmath)', ins: '\\sideset{}{}' },
  { label: t('Preíndice', 'Prescript'), sym: 'ˣ', hint: '\\prescript (mathtools)', ins: '\\prescript{}{}{}' },
];

// Closing / right delimiters (used with \right).
export const RIGHT_DELIMS = () => [
  { label: ')', hint: '\\right)', ins: ' \\right)' },
  { label: ']', hint: '\\right]', ins: ' \\right]' },
  { label: '}', hint: '\\right\\}', ins: ' \\right\\}' },
  { label: '⟩', hint: '\\right\\rangle', ins: ' \\right\\rangle' },
  { label: '(', hint: '\\right(', ins: ' \\right(' },
  { label: '[', hint: '\\right[', ins: ' \\right[' },
  { label: '{', hint: '\\right\\{', ins: ' \\right\\{' },
  { label: '|', hint: '\\right|', ins: ' \\right|' },
  { label: '‖', hint: '\\right\\|', ins: ' \\right\\|' },
  { label: '.', hint: '\\right. (invisible)', ins: ' \\right.' },
  { label: '⌋', hint: '\\right\\rfloor', ins: ' \\right\\rfloor' },
  { label: '⌉', hint: '\\right\\rceil', ins: ' \\right\\rceil' },
];

// Paragraph alignment (Home tab).
export const ALIGN = () => [
  { label: t('Izquierda', 'Left'), sym: '⇤', hint: 'flushleft', wrap: ['\\begin{flushleft}\n', '\n\\end{flushleft}'] },
  { label: t('Centrado', 'Center'), sym: '↔', hint: 'center', wrap: ['\\begin{center}\n', '\n\\end{center}'] },
  { label: t('Derecha', 'Right'), sym: '⇥', hint: 'flushright', wrap: ['\\begin{flushright}\n', '\n\\end{flushright}'] },
];

// Lists (Home tab).
export const LISTS = () => [
  { label: t('Viñetas', 'Bullets'), sym: '•', hint: 'itemize', wrap: ['\\begin{itemize}\n  \\item ', '\n\\end{itemize}'] },
  { label: t('Numerada', 'Numbered'), sym: '1.', hint: 'enumerate', wrap: ['\\begin{enumerate}\n  \\item ', '\n\\end{enumerate}'] },
  { label: t('Descripción', 'Description'), sym: '≔', hint: 'description', wrap: ['\\begin{description}\n  \\item[] ', '\n\\end{description}'] },
  { label: t('Elemento', 'Item'), sym: '‣', hint: '\\item', ins: '\\item ' },
];
