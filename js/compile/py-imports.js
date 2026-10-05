// The modules a Python cell imports, read from its text (no Python needed).
// Used to warm the kernel up before the first compile (compiler.js
// prewarmActive); the kernel decides what is actually safe to import.

const NAME = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/;

/** The modules a cell imports, as written: `import a.b as c, d` gives `a.b`
 *  and `d`; `from x.y import z` gives `x.y`. Relative imports (`from . import
 *  x`) are left out — they belong to the document's own folder — and so is
 *  anything inside a string or a comment line. */
export function importsOf(code) {
  const out = [];
  const src = stripStrings(String(code || ''));
  const re = /^[ \t]*(?:from[ \t]+([A-Za-z_][\w.]*)[ \t]+import\b|import[ \t]+([^\n#;]+))/gm;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) { if (NAME.test(m[1])) out.push(m[1]); continue; }
    for (const part of m[2].replace(/[()\\]/g, ' ').split(',')) {
      const name = part.trim().split(/[ \t]+as[ \t]+/)[0].trim();
      if (NAME.test(name)) out.push(name);
    }
  }
  return out;
}

// Blank out string literals (keeping line breaks, so `^` anchors still work):
// `"""import os"""` in a docstring is not an import.
function stripStrings(s) {
  return s.replace(/("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/g,
    (lit) => lit.replace(/[^\n]/g, ' '));
}
