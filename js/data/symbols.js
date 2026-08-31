// Math symbol palette for the side panel, organised like TeXstudio's symbol
// tabs. Each item is [glyph, command]; the glyph is shown in the grid and the
// command is inserted. Commands with braces (\frac{}{}) are inserted verbatim;
// the rest get a trailing space.

export const SYMBOL_CATEGORIES = [
  {
    name: 'Griegas minúsculas',
    items: [
      ['α', '\\alpha'], ['β', '\\beta'], ['γ', '\\gamma'], ['δ', '\\delta'],
      ['ε', '\\epsilon'], ['ϵ', '\\varepsilon'], ['ζ', '\\zeta'], ['η', '\\eta'],
      ['θ', '\\theta'], ['ϑ', '\\vartheta'], ['ι', '\\iota'], ['κ', '\\kappa'],
      ['λ', '\\lambda'], ['μ', '\\mu'], ['ν', '\\nu'], ['ξ', '\\xi'],
      ['ο', 'o'], ['π', '\\pi'], ['ϖ', '\\varpi'], ['ρ', '\\rho'],
      ['ϱ', '\\varrho'], ['σ', '\\sigma'], ['ς', '\\varsigma'], ['τ', '\\tau'],
      ['υ', '\\upsilon'], ['φ', '\\phi'], ['ϕ', '\\varphi'], ['χ', '\\chi'],
      ['ψ', '\\psi'], ['ω', '\\omega'],
    ],
  },
  {
    name: 'Griegas mayúsculas',
    items: [
      ['Γ', '\\Gamma'], ['Δ', '\\Delta'], ['Θ', '\\Theta'], ['Λ', '\\Lambda'],
      ['Ξ', '\\Xi'], ['Π', '\\Pi'], ['Σ', '\\Sigma'], ['Υ', '\\Upsilon'],
      ['Φ', '\\Phi'], ['Ψ', '\\Psi'], ['Ω', '\\Omega'],
    ],
  },
  {
    name: 'Operadores binarios',
    items: [
      ['±', '\\pm'], ['∓', '\\mp'], ['×', '\\times'], ['÷', '\\div'],
      ['⋅', '\\cdot'], ['∗', '\\ast'], ['⋆', '\\star'], ['∘', '\\circ'],
      ['∙', '\\bullet'], ['⊕', '\\oplus'], ['⊖', '\\ominus'], ['⊗', '\\otimes'],
      ['⊘', '\\oslash'], ['⊙', '\\odot'], ['∩', '\\cap'], ['∪', '\\cup'],
      ['⊎', '\\uplus'], ['⊓', '\\sqcap'], ['⊔', '\\sqcup'], ['∨', '\\vee'],
      ['∧', '\\wedge'], ['∖', '\\setminus'], ['≀', '\\wr'], ['⋄', '\\diamond'],
      ['△', '\\bigtriangleup'], ['▽', '\\bigtriangledown'], ['◁', '\\triangleleft'],
      ['▷', '\\triangleright'], ['†', '\\dagger'], ['‡', '\\ddagger'], ['⨿', '\\amalg'],
    ],
  },
  {
    name: 'Relaciones',
    items: [
      ['≤', '\\leq'], ['≥', '\\geq'], ['≡', '\\equiv'], ['⊨', '\\models'],
      ['≺', '\\prec'], ['≻', '\\succ'], ['∼', '\\sim'], ['⊥', '\\perp'],
      ['⪯', '\\preceq'], ['⪰', '\\succeq'], ['≃', '\\simeq'], ['∣', '\\mid'],
      ['≪', '\\ll'], ['≫', '\\gg'], ['≍', '\\asymp'], ['∥', '\\parallel'],
      ['⊂', '\\subset'], ['⊃', '\\supset'], ['≈', '\\approx'], ['⋈', '\\bowtie'],
      ['⊆', '\\subseteq'], ['⊇', '\\supseteq'], ['≅', '\\cong'], ['⊏', '\\sqsubset'],
      ['⊐', '\\sqsupset'], ['≠', '\\neq'], ['⌣', '\\smile'], ['⊑', '\\sqsubseteq'],
      ['⊒', '\\sqsupseteq'], ['≐', '\\doteq'], ['⌢', '\\frown'], ['∈', '\\in'],
      ['∋', '\\ni'], ['∝', '\\propto'], ['⊢', '\\vdash'], ['⊣', '\\dashv'],
      ['∉', '\\notin'],
    ],
  },
  {
    name: 'Flechas',
    items: [
      ['←', '\\leftarrow'], ['→', '\\rightarrow'], ['↔', '\\leftrightarrow'],
      ['⇐', '\\Leftarrow'], ['⇒', '\\Rightarrow'], ['⇔', '\\Leftrightarrow'],
      ['↑', '\\uparrow'], ['↓', '\\downarrow'], ['↕', '\\updownarrow'],
      ['⇑', '\\Uparrow'], ['⇓', '\\Downarrow'], ['⇕', '\\Updownarrow'],
      ['↦', '\\mapsto'], ['⟼', '\\longmapsto'], ['↩', '\\hookleftarrow'],
      ['↪', '\\hookrightarrow'], ['↼', '\\leftharpoonup'], ['⇀', '\\rightharpoonup'],
      ['↽', '\\leftharpoondown'], ['⇁', '\\rightharpoondown'], ['⇌', '\\rightleftharpoons'],
      ['⟵', '\\longleftarrow'], ['⟶', '\\longrightarrow'], ['⟷', '\\longleftrightarrow'],
      ['⟸', '\\Longleftarrow'], ['⟹', '\\Longrightarrow'], ['⟺', '\\Longleftrightarrow'],
      ['↗', '\\nearrow'], ['↘', '\\searrow'], ['↙', '\\swarrow'], ['↖', '\\nwarrow'],
      ['⇄', '\\rightleftarrows'], ['⇆', '\\leftrightarrows'],
    ],
  },
  {
    name: 'Grandes operadores',
    items: [
      ['∑', '\\sum'], ['∏', '\\prod'], ['∐', '\\coprod'], ['∫', '\\int'],
      ['∮', '\\oint'], ['∬', '\\iint'], ['∭', '\\iiint'], ['⋃', '\\bigcup'],
      ['⋂', '\\bigcap'], ['⋁', '\\bigvee'], ['⋀', '\\bigwedge'], ['⨁', '\\bigoplus'],
      ['⨂', '\\bigotimes'], ['⨀', '\\bigodot'], ['⨄', '\\biguplus'], ['⨆', '\\bigsqcup'],
    ],
  },
  {
    name: 'Delimitadores',
    items: [
      ['⟨', '\\langle'], ['⟩', '\\rangle'], ['⌊', '\\lfloor'], ['⌋', '\\rfloor'],
      ['⌈', '\\lceil'], ['⌉', '\\rceil'], ['‖', '\\|'], ['|', '\\vert'],
      ['{', '\\{'], ['}', '\\}'], ['⌊', '\\lfloor'], ['⟦', '\\llbracket'],
      ['⟧', '\\rrbracket'],
    ],
  },
  {
    name: 'Misceláneos',
    items: [
      ['∞', '\\infty'], ['∇', '\\nabla'], ['∂', '\\partial'], ['∀', '\\forall'],
      ['∃', '\\exists'], ['∄', '\\nexists'], ['∅', '\\emptyset'], ['∅', '\\varnothing'],
      ['¬', '\\neg'], ['♭', '\\flat'], ['♮', '\\natural'], ['♯', '\\sharp'],
      ['♣', '\\clubsuit'], ['♦', '\\diamondsuit'], ['♥', '\\heartsuit'], ['♠', '\\spadesuit'],
      ['∠', '\\angle'], ['∡', '\\measuredangle'], ['△', '\\triangle'], ['□', '\\square'],
      ['■', '\\blacksquare'], ['◇', '\\Diamond'], ['ℵ', '\\aleph'], ['ℏ', '\\hbar'],
      ['ℓ', '\\ell'], ['℘', '\\wp'], ['ℜ', '\\Re'], ['ℑ', '\\Im'],
      ['℧', '\\mho'], ['′', '\\prime'], ['√', '\\surd'], ['⊤', '\\top'],
      ['⊥', '\\bot'], ['∴', '\\therefore'], ['∵', '\\because'], ['…', '\\ldots'],
      ['⋯', '\\cdots'], ['⋮', '\\vdots'], ['⋱', '\\ddots'], ['°', '\\degree'],
      ['§', '\\S'], ['¶', '\\P'], ['©', '\\copyright'], ['£', '\\pounds'],
    ],
  },
  {
    name: 'Funciones',
    items: [
      ['sin', '\\sin'], ['cos', '\\cos'], ['tan', '\\tan'], ['cot', '\\cot'],
      ['sec', '\\sec'], ['csc', '\\csc'], ['arcsin', '\\arcsin'], ['arccos', '\\arccos'],
      ['arctan', '\\arctan'], ['sinh', '\\sinh'], ['cosh', '\\cosh'], ['tanh', '\\tanh'],
      ['log', '\\log'], ['ln', '\\ln'], ['exp', '\\exp'], ['lim', '\\lim'],
      ['max', '\\max'], ['min', '\\min'], ['sup', '\\sup'], ['inf', '\\inf'],
      ['det', '\\det'], ['dim', '\\dim'], ['ker', '\\ker'], ['gcd', '\\gcd'],
      ['deg', '\\deg'], ['arg', '\\arg'], ['mod', '\\bmod'],
    ],
  },
  {
    name: 'Acentos y construcciones',
    items: [
      ['x̂', '\\hat{}'], ['x̃', '\\tilde{}'], ['x̄', '\\bar{}'], ['x⃗', '\\vec{}'],
      ['ẋ', '\\dot{}'], ['ẍ', '\\ddot{}'], ['x̆', '\\breve{}'], ['x̌', '\\check{}'],
      ['x́', '\\acute{}'], ['x̀', '\\grave{}'], ['ŷ', '\\widehat{}'], ['ỹ', '\\widetilde{}'],
      ['‾', '\\overline{}'], ['_', '\\underline{}'], ['⏞', '\\overbrace{}'], ['⏟', '\\underbrace{}'],
      ['→', '\\overrightarrow{}'], ['√', '\\sqrt{}'], ['ⁿ√', '\\sqrt[n]{}'], ['½', '\\frac{}{}'],
      ['xⁿ', '^{}'], ['xₙ', '_{}'],
    ],
  },
  {
    name: 'Negaciones',
    items: [
      ['≠', '\\neq'], ['∉', '\\notin'], ['≮', '\\nless'], ['≯', '\\ngtr'],
      ['≰', '\\nleq'], ['≱', '\\ngeq'], ['⊄', '\\nsubset'], ['⊅', '\\nsupset'],
      ['⊈', '\\nsubseteq'], ['⊉', '\\nsupseteq'], ['∤', '\\nmid'], ['∦', '\\nparallel'],
      ['≄', '\\nsimeq'], ['≇', '\\ncong'], ['≉', '\\napprox'], ['⊀', '\\nprec'],
      ['⊁', '\\nsucc'], ['⊬', '\\nvdash'], ['⊭', '\\nvDash'], ['↛', '\\nrightarrow'],
      ['↚', '\\nleftarrow'], ['⇏', '\\nRightarrow'], ['⇎', '\\nLeftrightarrow'],
    ],
  },
  {
    name: 'Conjuntos numéricos',
    items: [
      ['ℕ', '\\mathbb{N}'], ['ℤ', '\\mathbb{Z}'], ['ℚ', '\\mathbb{Q}'],
      ['ℝ', '\\mathbb{R}'], ['ℂ', '\\mathbb{C}'], ['ℍ', '\\mathbb{H}'],
      ['𝔼', '\\mathbb{E}'], ['ℙ', '\\mathbb{P}'], ['𝟙', '\\mathbb{1}'],
      ['𝒜', '\\mathcal{A}'], ['ℬ', '\\mathcal{B}'], ['ℱ', '\\mathcal{F}'],
      ['ℒ', '\\mathcal{L}'], ['𝔄', '\\mathfrak{A}'], ['𝔤', '\\mathfrak{g}'],
    ],
  },
];

// Build the text to insert for a symbol command.
export function insertText(cmd) {
  return cmd.includes('{') || cmd.includes('^') || cmd.includes('_') ? cmd : cmd + ' ';
}
