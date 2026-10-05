// Offline math rendering for handcalcs results and every `text/latex` output
// (sympy, IPython's Math/Latex, anything with a _repr_latex_).
//
// The kernel used to emit an HTML blob that pulled KaTeX from a CDN and called
// `katex.render` in a script tag. That made the flagship feature of the app —
// seeing a textbook-style calculation next to its cell — depend on an internet
// connection, and it needed a script-bearing iframe to work at all. On a
// desktop tool for engineering documents, neither is acceptable.
//
// KaTeX is now bundled with the app and runs HERE, in the host page. The kernel
// just returns the LaTeX, exactly as Jupyter would receive it (delimiters
// included); math-split.js decides what is a formula and what is prose. The
// result is static markup: no scripts, no network, no iframe, and it can be
// selected and copied like any other output.

import katex from 'katex';
import 'katex/dist/katex.min.css';
import { splitMath } from './math-split.js';

function katexInto(el, src, display) {
  try {
    el.innerHTML = katex.renderToString(src, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'html',
    });
  } catch (_) {
    // A malformed expression shows as its own source, which is far more
    // useful to the author than an empty box.
    const pre = document.createElement('pre');
    pre.className = 'pyx-katex-src';
    pre.textContent = src;
    el.replaceChildren(pre);
  }
}

/**
 * Render a text/latex output into a DOM element. Never throws.
 */
export function renderMath(latex) {
  const wrap = document.createElement('div');
  wrap.className = 'pyx-katex';
  const parts = splitMath(latex);
  if (parts.length === 1 && parts[0].type === 'math') {
    katexInto(wrap, parts[0].value, true);
    return wrap;
  }
  // Prose with formulas in it: a paragraph, the formulas typeset in place.
  const p = document.createElement('div');
  p.className = 'pyx-katex-text';
  for (const part of parts) {
    if (part.type === 'text') {
      p.appendChild(document.createTextNode(part.value));
    } else {
      const m = document.createElement(part.display ? 'div' : 'span');
      katexInto(m, part.value, !!part.display);
      p.appendChild(m);
    }
  }
  wrap.appendChild(p);
  return wrap;
}
