// Offline math rendering for handcalcs results.
//
// The kernel used to emit an HTML blob that pulled KaTeX from a CDN and called
// `katex.render` in a script tag. That made the flagship feature of the app —
// seeing a textbook-style calculation next to its cell — depend on an internet
// connection, and it needed a script-bearing iframe to work at all. On a
// desktop tool for engineering documents, neither is acceptable.
//
// KaTeX is now bundled with the app and runs HERE, in the host page. The kernel
// just returns the LaTeX. The result is static markup: no scripts, no network,
// no iframe, and it can be selected and copied like any other output.

import katex from 'katex';
import 'katex/dist/katex.min.css';

/** Strip the outer display-math delimiters handcalcs wraps its output in. */
function stripDelims(latex) {
  let s = String(latex || '').trim();
  if (s.startsWith('\\[')) s = s.slice(2);
  if (s.endsWith('\\]')) s = s.slice(0, -2);
  return s.trim();
}

/**
 * Render display math into a DOM element.
 * Never throws: a malformed expression shows as its own source, which is far
 * more useful to the author than an empty box.
 */
export function renderMath(latex) {
  const wrap = document.createElement('div');
  wrap.className = 'pyx-katex';
  const src = stripDelims(latex);
  if (!src) return wrap;
  try {
    wrap.innerHTML = katex.renderToString(src, {
      displayMode: true,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'html',
    });
  } catch (_) {
    const pre = document.createElement('pre');
    pre.className = 'pyx-katex-src';
    pre.textContent = src;
    wrap.appendChild(pre);
  }
  return wrap;
}
