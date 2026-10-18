// Line diff (Myers' O(ND) algorithm, the one Git uses by default): what
// changed between two versions of a document, as runs of kept, removed and
// added lines — for the version history's comparison.

/**
 * @returns {{type:' '|'-'|'+', a?:number, b?:number, text:string}[]}  a/b: 1-based line numbers
 */
export function diffLines(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length, m = b.length;
  const max = n + m;
  const off = max;
  let v = new Int32Array(2 * max + 2);
  const trace = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { done = true; break; }
    }
    if (d > 5000) break; // wildly different texts: give up on minimality
  }
  // Walk the trace back to the start.
  const out = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) ? k + 1 : k - 1;
    const px = vv[off + prevK];
    const py = px - prevK;
    while (x > px && y > py) { out.push({ type: ' ', a: x, b: y, text: a[x - 1] }); x--; y--; }
    if (d === 0) break;
    if (x === px) { out.push({ type: '+', b: y, text: b[y - 1] }); y--; }
    else { out.push({ type: '-', a: x, text: a[x - 1] }); x--; }
  }
  while (x > 0 && y > 0) { out.push({ type: ' ', a: x, b: y, text: a[x - 1] }); x--; y--; }
  while (x > 0) { out.push({ type: '-', a: x, text: a[x - 1] }); x--; }
  while (y > 0) { out.push({ type: '+', b: y, text: b[y - 1] }); y--; }
  return out.reverse();
}

/** Only the changes, with `context` unchanged lines around each (like `git diff`). */
export function hunks(diff, context = 2) {
  const keep = new Uint8Array(diff.length);
  diff.forEach((d, i) => {
    if (d.type === ' ') return;
    for (let j = Math.max(0, i - context); j <= Math.min(diff.length - 1, i + context); j++) keep[j] = 1;
  });
  const out = [];
  let gap = false;
  diff.forEach((d, i) => {
    if (keep[i]) { out.push(d); gap = false; } else if (!gap) { out.push({ type: '…', text: '' }); gap = true; }
  });
  return out;
}
