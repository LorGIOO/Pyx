// What a `text/latex` output means, before KaTeX sees it.
//
// Jupyter's text/latex is the object's own `_repr_latex_`, delimiters and all:
//   handcalcs          \[ \begin{aligned} … \end{aligned} \]
//   sympy              $\displaystyle \frac{x^{2}}{3}$
//   IPython Math       $$\int x\,dx$$
//   IPython Latex      'La fuerza vale $F = 12$ kN'   ← text WITH math in it
// Handing any of these to KaTeX whole either failed on the `$` or typeset the
// prose as one long italic formula. So: one outer pair of delimiters → a
// single formula; math inside text → text and formulas, each rendered as what
// it is; no delimiters at all → a formula (handcalcs' environment, a bare
// expression).

const PAIRS = [['$$', '$$'], ['\\[', '\\]'], ['\\(', '\\)'], ['$', '$']];

function unwrap(s) {
  for (const [a, b] of PAIRS) {
    if (s.startsWith(a) && s.endsWith(b) && s.length > a.length + b.length) {
      const inner = s.slice(a.length, s.length - b.length);
      // `$a$ y $b$` starts and ends with `$` but is two formulas, not one.
      if (a === '$' && /(^|[^\\])\$/.test(inner)) continue;
      if (a === '$$' && inner.includes('$$')) continue;
      return { inner: inner.trim(), display: a !== '$' && a !== '\\(' };
    }
  }
  return null;
}

// $$…$$ | \[…\] | \(…\) | $…$ (unescaped, not empty)
const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$])\$(?!\$)((?:\\.|[^$\\])+?)\$/g;

/**
 * @returns {{type: 'math'|'text', value: string, display?: boolean}[]}
 */
export function splitMath(latex) {
  const s = String(latex ?? '').trim();
  if (!s) return [];
  const whole = unwrap(s);
  if (whole) return [{ type: 'math', value: whole.inner, display: true }];
  const parts = [];
  let last = 0;
  let found = false;
  MATH.lastIndex = 0;
  let m;
  while ((m = MATH.exec(s))) {
    found = true;
    if (m.index > last) parts.push({ type: 'text', value: s.slice(last, m.index) });
    const display = m[1] !== undefined || m[2] !== undefined;
    const value = (m[1] ?? m[2] ?? m[3] ?? m[4]).trim();
    parts.push({ type: 'math', value, display });
    last = MATH.lastIndex;
  }
  if (!found) return [{ type: 'math', value: s, display: true }];
  if (last < s.length) parts.push({ type: 'text', value: s.slice(last) });
  return parts;
}
