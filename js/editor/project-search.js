// Search across every file of a project — TeXstudio's "Buscar en archivos",
// VS Code's Ctrl+Shift+F. Pure: the panel gives it the texts (the open
// documents as they are in the editor, the rest from disk) and gets back
// every match with its line, column and the line itself.

/** The RegExp for a query, or null if it is empty or an invalid pattern. */
export function queryRegExp(query, { caseSensitive = false, regexp = false, whole = false } = {}) {
  if (!query) return null;
  let src = regexp ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (whole) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(src, `gu${caseSensitive ? '' : 'i'}`);
  } catch (_) {
    return null;
  }
}

/**
 * @param {{path:string, text:string}[]} files
 * @returns {{files: {path:string, matches:{line:number, col:number, len:number, text:string}[]}[], total:number, capped:boolean}}
 */
export function searchTexts(files, query, opts = {}, max = 5000) {
  const re = queryRegExp(query, opts);
  const out = { files: [], total: 0, capped: false };
  if (!re) return out;
  for (const f of files) {
    const matches = [];
    const lines = f.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        matches.push({ line: i + 1, col: m.index, len: m[0].length, text: line });
        if (++out.total >= max) { out.capped = true; break; }
      }
      if (out.capped) break;
    }
    if (matches.length) out.files.push({ path: f.path, matches });
    if (out.capped) break;
  }
  return out;
}

/** `text` with every match replaced; `$1`… work with regular expressions. */
export function replaceInText(text, query, replacement, opts = {}) {
  const re = queryRegExp(query, opts);
  if (!re) return { text, count: 0 };
  let count = 0;
  const out = text.replace(re, (...args) => {
    count++;
    if (!opts.regexp) return replacement;
    // Expand $1, $2… and $& like String.prototype.replace would.
    const groups = args.slice(1, -2);
    return replacement.replace(/\$(\d+|&)/g, (_, g) => (g === '&' ? args[0] : (groups[+g - 1] ?? '')));
  });
  return { text: out, count };
}
