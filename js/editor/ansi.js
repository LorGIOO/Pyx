// Terminal text as a notebook shows it.
//
// Cell output is what a program wrote to a terminal: colour codes from
// coloured loggers, rich, pytest or pip (`\x1b[31m…`), and `\r` from progress
// bars (tqdm, `print(f'\rpaso {i}', end='')`) that redraw the SAME line. Shown
// raw, the first came out as `[31m` litter and the second as
// `paso 0paso 1paso 2…` or a run-on `0%|…|100%|███…`. Jupyter renders both;
// so does this.

/** `\r` redraws the line: keep what the line finally shows. */
export function collapseCR(text) {
  const s = String(text ?? '');
  if (!s.includes('\r')) return s;
  return s.replace(/\r\n/g, '\n').split('\n').map((line) => {
    if (!line.includes('\r')) return line;
    const parts = line.split('\r');
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i] !== '') return parts[i];
    return '';
  }).join('\n');
}

// VS Code's terminal palette: readable on the light and the dark theme.
const BASIC = [
  '#000000', '#cd3131', '#0dbc79', '#b58900', '#2472c8', '#bc3fbc', '#11a8cd', '#8a8a8a',
  '#666666', '#f14c4c', '#23d18b', '#c7a600', '#3b8eea', '#d670d6', '#29b8db', '#a5a5a5',
];

function color256(n) {
  if (n < 16) return BASIC[n];
  if (n < 232) {
    const v = n - 16;
    const c = (x) => (x ? 55 + x * 40 : 0);
    return `rgb(${c(Math.floor(v / 36))},${c(Math.floor(v / 6) % 6)},${c(v % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

// SGR sequences (colours, bold…) are interpreted; every other escape
// sequence (cursor moves, erase-line, window titles) is dropped.
const ESC = /\x1b\[([0-9;]*)m|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Split terminal text into runs of plain text with their style.
 * @returns {{text: string, style: {fg?: string, bg?: string, bold?: boolean,
 *   italic?: boolean, underline?: boolean, dim?: boolean}}[]}
 */
export function ansiRuns(text) {
  const s = collapseCR(text);
  const runs = [];
  let style = {};
  let last = 0;
  const push = (t) => {
    if (!t) return;
    const prev = runs[runs.length - 1];
    if (prev && JSON.stringify(prev.style) === JSON.stringify(style)) prev.text += t;
    else runs.push({ text: t, style: { ...style } });
  };
  ESC.lastIndex = 0;
  let m;
  while ((m = ESC.exec(s))) {
    push(s.slice(last, m.index));
    last = ESC.lastIndex;
    if (m[1] === undefined) continue; // not a colour: drop it
    const codes = m[1] === '' ? [0] : m[1].split(';').map((x) => parseInt(x || '0', 10));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) style = {};
      else if (c === 1) style.bold = true;
      else if (c === 2) style.dim = true;
      else if (c === 3) style.italic = true;
      else if (c === 4) style.underline = true;
      else if (c === 22) { delete style.bold; delete style.dim; }
      else if (c === 23) delete style.italic;
      else if (c === 24) delete style.underline;
      else if (c >= 30 && c <= 37) style.fg = BASIC[c - 30];
      else if (c >= 90 && c <= 97) style.fg = BASIC[c - 90 + 8];
      else if (c === 39) delete style.fg;
      else if (c >= 40 && c <= 47) style.bg = BASIC[c - 40];
      else if (c >= 100 && c <= 107) style.bg = BASIC[c - 100 + 8];
      else if (c === 49) delete style.bg;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5 && codes[i + 2] != null) {
        style[c === 38 ? 'fg' : 'bg'] = color256(codes[i + 2]);
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2 && codes[i + 4] != null) {
        style[c === 38 ? 'fg' : 'bg'] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      }
    }
  }
  push(s.slice(last));
  return runs;
}

/** Terminal text as DOM: text nodes, and spans where a colour applies. */
export function ansiFragment(text) {
  const frag = document.createDocumentFragment();
  for (const { text: t, style } of ansiRuns(text)) {
    if (!Object.keys(style).length) { frag.appendChild(document.createTextNode(t)); continue; }
    const span = document.createElement('span');
    if (style.fg) span.style.color = style.fg;
    if (style.bg) span.style.backgroundColor = style.bg;
    if (style.bold) span.style.fontWeight = 'bold';
    if (style.italic) span.style.fontStyle = 'italic';
    if (style.underline) span.style.textDecoration = 'underline';
    if (style.dim) span.style.opacity = '0.7';
    span.textContent = t;
    frag.appendChild(span);
  }
  return frag;
}
