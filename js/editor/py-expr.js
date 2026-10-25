// Where the caret is, inside a \py{…} / \pyif{…} of the LaTeX text (for completion).

/** The text of the \py{ / \pyif{ group the caret is in on this line (up to
 *  the caret), or null. */
export function pyExprBefore(before) {
  let depth = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const ch = before[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth > 0) { depth--; continue; }
      const head = before.slice(0, i);
      // (\py*{…} is the escaped form: literal text, nothing to complete.)
      if (/\\py$/.test(head) || /\\pyif$/.test(head)) return before.slice(i + 1);
      // `{` of a dict or set inside the expression: keep looking outward.
      if (/\\[A-Za-z@]+\*?$/.test(head)) return null;
    }
  }
  return null;
}
