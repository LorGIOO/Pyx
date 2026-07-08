// Data for the Home-tab toolbar dropdowns (TeXstudio-style).
// Each item: { label, hint?, wrap?: [before, after], ins?: text }.
//  - wrap  → wraps the current selection (cursor lands inside if empty)
//  - ins   → inserts the literal text at the cursor

import { wrap, insertSnippet } from '../editor/commands.js';

export function runSnippet(item) {
  if (item.wrap) wrap(item.wrap[0], item.wrap[1]);
  else if (item.ins != null) insertSnippet(item.ins);
}

// Sectioning, like TeXstudio's structure toolbar (incl. starred forms). Each
// item shows a level badge (Pt · Cap · S1/S2/S3 · ¶) so the hierarchy is
// visible at a glance.
export const STRUCTURE = [
  { label: 'Parte', badge: 'Pt', hint: '\\part', wrap: ['\\part{', '}'] },
  { label: 'Capítulo', badge: 'Cap', hint: '\\chapter', wrap: ['\\chapter{', '}'] },
  { label: 'Sección', badge: 'S1', hint: '\\section', wrap: ['\\section{', '}'] },
  { label: 'Subsección', badge: 'S2', hint: '\\subsection', wrap: ['\\subsection{', '}'] },
  { label: 'Subsubsección', badge: 'S3', hint: '\\subsubsection', wrap: ['\\subsubsection{', '}'] },
  { label: 'Párrafo', badge: '¶', hint: '\\paragraph', wrap: ['\\paragraph{', '}'] },
  { label: 'Subpárrafo', badge: '¶¶', hint: '\\subparagraph', wrap: ['\\subparagraph{', '}'] },
  { label: 'Parte*', badge: 'Pt', hint: '\\part*', wrap: ['\\part*{', '}'] },
  { label: 'Capítulo*', badge: 'Cap', hint: '\\chapter*', wrap: ['\\chapter*{', '}'] },
  { label: 'Sección*', badge: 'S1', hint: '\\section*', wrap: ['\\section*{', '}'] },
  { label: 'Subsección*', badge: 'S2', hint: '\\subsection*', wrap: ['\\subsection*{', '}'] },
  { label: 'Subsubsección*', badge: 'S3', hint: '\\subsubsection*', wrap: ['\\subsubsection*{', '}'] },
];

// LaTeX font sizes, named like TeXstudio. The badge is an "A" rendered AT the
// relative size, so the menu previews each size visually.
const sizeBadge = (px) => ({ badge: 'A', badgeStyle: { 'font-size': px + 'px' } });
export const FONT_SIZES = [
  { label: 'Enana', hint: '\\tiny', ...sizeBadge(8), wrap: ['{\\tiny ', '}'] },
  { label: 'Tamaño índices', hint: '\\scriptsize', ...sizeBadge(9), wrap: ['{\\scriptsize ', '}'] },
  { label: 'Tamaño nota al pie', hint: '\\footnotesize', ...sizeBadge(10), wrap: ['{\\footnotesize ', '}'] },
  { label: 'Pequeña', hint: '\\small', ...sizeBadge(11), wrap: ['{\\small ', '}'] },
  { label: 'Tamaño normal', hint: '\\normalsize', ...sizeBadge(12), wrap: ['{\\normalsize ', '}'] },
  { label: 'grande', hint: '\\large', ...sizeBadge(13), wrap: ['{\\large ', '}'] },
  { label: 'Grande', hint: '\\Large', ...sizeBadge(14), wrap: ['{\\Large ', '}'] },
  { label: 'GRANDE', hint: '\\LARGE', ...sizeBadge(15), wrap: ['{\\LARGE ', '}'] },
  { label: 'enorme', hint: '\\huge', ...sizeBadge(16), wrap: ['{\\huge ', '}'] },
  { label: 'Enorme', hint: '\\Huge', ...sizeBadge(17), wrap: ['{\\Huge ', '}'] },
];

// Labels / references, like TeXstudio's label toolbar.
export const LABELS = [
  { label: 'Etiqueta', sym: '⚓', hint: '\\label', wrap: ['\\label{', '}'] },
  { label: 'ref', sym: '#', hint: '\\ref', wrap: ['\\ref{', '}'] },
  { label: 'eqref', sym: '#', hint: '\\eqref', wrap: ['\\eqref{', '}'] },
  { label: 'pageref', sym: '¶', hint: '\\pageref', wrap: ['\\pageref{', '}'] },
  { label: 'Índice', sym: '☰', hint: '\\index', wrap: ['\\index{', '}'] },
  { label: 'cita', sym: '❝', hint: '\\cite', wrap: ['\\cite{', '}'] },
  { label: 'Nota al Pie', sym: '†', hint: '\\footnote', wrap: ['\\footnote{', '}'] },
];

// Opening / left delimiters (used with \left). The menu shows the VISUAL
// symbol; the LaTeX it inserts appears as the hint (and is what reaches the
// document) — TeXstudio-style, but friendlier to read.
export const LEFT_DELIMS = [
  { label: '(', hint: '\\left(', ins: '\\left( ' },
  { label: '[', hint: '\\left[', ins: '\\left[ ' },
  { label: '{', hint: '\\left\\{', ins: '\\left\\{ ' },
  { label: '⟨', hint: '\\left\\langle', ins: '\\left\\langle ' },
  { label: ')', hint: '\\left)', ins: '\\left) ' },
  { label: ']', hint: '\\left]', ins: '\\left] ' },
  { label: '}', hint: '\\left\\}', ins: '\\left\\} ' },
  { label: '|', hint: '\\left|', ins: '\\left| ' },
  { label: '‖', hint: '\\left\\|', ins: '\\left\\| ' },
  { label: '.', hint: '\\left. (invisible)', ins: '\\left. ' },
  { label: '⌊', hint: '\\left\\lfloor', ins: '\\left\\lfloor ' },
  { label: '⌈', hint: '\\left\\lceil', ins: '\\left\\lceil ' },
];

// ---- Math tab data ----

// Display/equation environments (amsmath), like TeXstudio's "Ecuaciones".
export const MATH_ENVIRONMENTS = [
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
export const MATH_FUNCTIONS = ['arccos', 'arcsin', 'arctan', 'arg', 'cos', 'cosh', 'cot', 'coth',
  'csc', 'deg', 'det', 'dim', 'exp', 'gcd', 'hom', 'inf', 'ker', 'lg', 'lim', 'liminf', 'limsup',
  'ln', 'log', 'max', 'min', 'sec', 'sin', 'sinh', 'sup', 'tan', 'tanh', 'Pr']
  .map((f) => ({ label: '\\' + f, sym: 'ƒ', ins: '\\' + f + ' ' }));

// Theorem-like environments (ntheorem / amsthm).
export const MATH_THEOREMS = [
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
export const MATH_FONTS = [
  { label: 'Romana', sym: 'A', hint: '\\mathrm', wrap: ['\\mathrm{', '}'] },
  { label: 'Itálica', sym: '𝐴', hint: '\\mathit', wrap: ['\\mathit{', '}'] },
  { label: 'Negrita', sym: '𝐀', hint: '\\mathbf', wrap: ['\\mathbf{', '}'] },
  { label: 'Sans Serif', sym: '𝖠', hint: '\\mathsf', wrap: ['\\mathsf{', '}'] },
  { label: 'Máquina de escribir', sym: '𝙰', hint: '\\mathtt', wrap: ['\\mathtt{', '}'] },
  { label: 'Caligráfica', sym: '𝒜', hint: '\\mathcal', wrap: ['\\mathcal{', '}'] },
  { label: 'Pizarra (amssymb)', sym: '𝔸', hint: '\\mathbb', wrap: ['\\mathbb{', '}'] },
  { label: 'Fraktur (amssymb)', sym: '𝔄', hint: '\\mathfrak', wrap: ['\\mathfrak{', '}'] },
];

// Stackable operators (sub/superscript limits).
export const MATH_STACK = [
  { label: 'Sumatorio', sym: '∑', hint: '\\sum', ins: '\\sum_{}^{}' },
  { label: 'Productorio', sym: '∏', hint: '\\prod', ins: '\\prod_{}^{}' },
  { label: 'Coproducto', sym: '∐', hint: '\\coprod', ins: '\\coprod_{}^{}' },
  { label: 'Integral', sym: '∫', hint: '\\int', ins: '\\int_{}^{}' },
  { label: 'Integral doble', sym: '∬', hint: '\\iint', ins: '\\iint_{}^{}' },
  { label: 'Integral curvilínea', sym: '∮', hint: '\\oint', ins: '\\oint_{}^{}' },
  { label: 'Unión', sym: '⋃', hint: '\\bigcup', ins: '\\bigcup_{}^{}' },
  { label: 'Intersección', sym: '⋂', hint: '\\bigcap', ins: '\\bigcap_{}^{}' },
  { label: 'Límite', sym: 'lim', hint: '\\lim', ins: '\\lim_{}' },
  { label: 'Máximo', sym: 'max', hint: '\\max', ins: '\\max_{}' },
  { label: 'Mínimo', sym: 'min', hint: '\\min', ins: '\\min_{}' },
  { label: 'Suma directa', sym: '⨁', hint: '\\bigoplus', ins: '\\bigoplus_{}^{}' },
  { label: 'Producto tensorial', sym: '⨂', hint: '\\bigotimes', ins: '\\bigotimes_{}^{}' },
];

// Math accents (pure accents — over/under constructs live in MATH_OVERUNDER to
// avoid duplication).
export const MATH_ACCENTS = [
  { label: 'Sombrero', sym: 'x̂', hint: '\\hat', wrap: ['\\hat{', '}'] },
  { label: 'Tilde', sym: 'x̃', hint: '\\tilde', wrap: ['\\tilde{', '}'] },
  { label: 'Barra', sym: 'x̄', hint: '\\bar', wrap: ['\\bar{', '}'] },
  { label: 'Vector', sym: 'x⃗', hint: '\\vec', wrap: ['\\vec{', '}'] },
  { label: 'Punto', sym: 'ẋ', hint: '\\dot', wrap: ['\\dot{', '}'] },
  { label: 'Doble punto', sym: 'ẍ', hint: '\\ddot', wrap: ['\\ddot{', '}'] },
  { label: 'Sombrero ancho', sym: 'x͆', hint: '\\widehat', wrap: ['\\widehat{', '}'] },
  { label: 'Tilde ancha', sym: 'x̃', hint: '\\widetilde', wrap: ['\\widetilde{', '}'] },
  { label: 'Breve', sym: 'x̆', hint: '\\breve', wrap: ['\\breve{', '}'] },
  { label: 'Check', sym: 'x̌', hint: '\\check', wrap: ['\\check{', '}'] },
  { label: 'Agudo', sym: 'x́', hint: '\\acute', wrap: ['\\acute{', '}'] },
  { label: 'Grave', sym: 'x̀', hint: '\\grave', wrap: ['\\grave{', '}'] },
];

// HORIZONTAL spacing (↔) — exactly TeXstudio's "Espacios horizontales" set.
export const HSPACES = [
  { label: 'Espacio', sym: '␣', hint: '\\space', ins: '\\space ' },
  { label: 'Medio cuadratín', sym: '⸱', hint: '\\enspace', ins: '\\enspace ' },
  { label: 'Cuad  (1 em)', sym: '▯', hint: '\\quad', ins: '\\quad ' },
  { label: 'Doble cuad  (2 em)', sym: '▭', hint: '\\qquad', ins: '\\qquad ' },
  { label: 'Fino', sym: '‧', hint: '\\thinspace', ins: '\\thinspace ' },
  { label: 'Fino negativo', sym: '⨪', hint: '\\negthinspace', ins: '\\negthinspace ' },
  { label: 'A medida', sym: '↔', hint: '\\hspace', wrap: ['\\hspace{', '}'] },
  { label: 'Relleno', sym: '⇥', hint: '\\hfill', ins: '\\hfill ' },
  { label: 'Relleno con línea', sym: '—', hint: '\\hrulefill', ins: '\\hrulefill ' },
  { label: 'Relleno con puntos', sym: '⋯', hint: '\\dotfill', ins: '\\dotfill ' },
];

// VERTICAL spacing + breaks (↕) — TeXstudio's "Espacios verticales" set.
export const VSPACES = [
  { label: 'Nueva página', sym: '⤓', hint: '\\newpage', ins: '\\newpage\n' },
  { label: 'Salto de línea', sym: '↵', hint: '\\linebreak', ins: '\\linebreak\n' },
  { label: 'Salto de página', sym: '⤵', hint: '\\pagebreak', ins: '\\pagebreak\n' },
  { label: 'Salto grande', sym: '⇕', hint: '\\bigskip', ins: '\\bigskip\n' },
  { label: 'Salto medio', sym: '↕', hint: '\\medskip', ins: '\\medskip\n' },
  { label: 'Salto pequeño', sym: '˅', hint: '\\smallskip', ins: '\\smallskip\n' },
  { label: 'A medida', sym: '↕', hint: '\\vspace', wrap: ['\\vspace{', '}'] },
  { label: 'Relleno', sym: '⤓', hint: '\\vfill', ins: '\\vfill\n' },
  { label: 'Salto de línea  (Ctrl+Retorno)', sym: '↵', hint: '\\\\', ins: '\\\\\n' },
];

// Over/under (stacked) math constructs — TeXstudio's stackable symbols. These
// are NOT in the side-panel symbol palette, so there is no redundancy.
export const MATH_OVERUNDER = [
  { label: 'Línea encima', sym: 'x̅', hint: '\\overline', wrap: ['\\overline{', '}'] },
  { label: 'Línea debajo', sym: 'x̲', hint: '\\underline', wrap: ['\\underline{', '}'] },
  { label: 'Llave encima', sym: '⏞', hint: '\\overbrace', wrap: ['\\overbrace{', '}'] },
  { label: 'Llave debajo', sym: '⏟', hint: '\\underbrace', wrap: ['\\underbrace{', '}'] },
  { label: 'Flecha izq. encima', sym: 'x⃖', hint: '\\overleftarrow', wrap: ['\\overleftarrow{', '}'] },
  { label: 'Flecha der. encima', sym: 'x⃗', hint: '\\overrightarrow', wrap: ['\\overrightarrow{', '}'] },
  { label: 'Apilar relación', sym: '≜', hint: '\\stackrel', ins: '\\stackrel{}{}' },
  { label: 'Encima de', sym: '⊤', hint: '\\overset (amsmath)', ins: '\\overset{}{}' },
  { label: 'Debajo de', sym: '⊥', hint: '\\underset (amsmath)', ins: '\\underset{}{}' },
  { label: 'Índices laterales', sym: '⋊', hint: '\\sideset (amsmath)', ins: '\\sideset{}{}' },
  { label: 'Preíndice', sym: 'ˣ', hint: '\\prescript (mathtools)', ins: '\\prescript{}{}{}' },
];

// Closing / right delimiters (used with \right).
export const RIGHT_DELIMS = [
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
export const ALIGN = [
  { label: 'Izquierda', sym: '⇤', hint: 'flushleft', wrap: ['\\begin{flushleft}\n', '\n\\end{flushleft}'] },
  { label: 'Centrado', sym: '↔', hint: 'center', wrap: ['\\begin{center}\n', '\n\\end{center}'] },
  { label: 'Derecha', sym: '⇥', hint: 'flushright', wrap: ['\\begin{flushright}\n', '\n\\end{flushright}'] },
];

// Lists (Home tab).
export const LISTS = [
  { label: 'Viñetas', sym: '•', hint: 'itemize', wrap: ['\\begin{itemize}\n  \\item ', '\n\\end{itemize}'] },
  { label: 'Numerada', sym: '1.', hint: 'enumerate', wrap: ['\\begin{enumerate}\n  \\item ', '\n\\end{enumerate}'] },
  { label: 'Descripción', sym: '≔', hint: 'description', wrap: ['\\begin{description}\n  \\item[] ', '\n\\end{description}'] },
  { label: 'Elemento', sym: '‣', hint: '\\item', ins: '\\item ' },
];
