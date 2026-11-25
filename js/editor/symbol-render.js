// Symbol commands drawn in the editor: `\textordfeminine` shows «ª», `\S`
// «§», `\euro` «€»… and a symbol of one's own made from an SVG shows its
// drawing. The command comes back as soon as the cursor touches it (to edit
// it), and the text of the document never changes: it is only how it looks.

import { ViewPlugin, Decoration, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { mySymbols } from '../data/svg-symbols.js';
import { createRoot, createEffect } from 'solid-js';

// Text-mode symbols (LaTeX kernel, textcomp, babel's Spanish ones).
export const TEXT_SYMBOLS = {
  textordfeminine: 'ª', textordmasculine: 'º', textdegree: '°', textcelsius: '℃',
  S: '§', P: '¶', textsection: '§', textparagraph: '¶',
  copyright: '©', textcopyright: '©', textregistered: '®', texttrademark: '™',
  euro: '€', texteuro: '€', pounds: '£', textsterling: '£', textyen: '¥', textcent: '¢', textdollar: '$',
  dag: '†', ddag: '‡', textdagger: '†', textdaggerdbl: '‡',
  ldots: '…', dots: '…', textellipsis: '…', textbullet: '•', textperiodcentered: '·',
  guillemotleft: '«', guillemotright: '»', guillemetleft: '«', guillemetright: '»', flqq: '«', frqq: '»',
  textquestiondown: '¿', textexclamdown: '¡', textmu: 'µ', textohm: 'Ω', textperthousand: '‰',
  textonehalf: '½', textonequarter: '¼', textthreequarters: '¾', textonesuperior: '¹', texttwosuperior: '²', textthreesuperior: '³',
  texttimes: '×', textdiv: '÷', textpm: '±', textminus: '−', textlnot: '¬', textmusicalnote: '♪',
  textleftarrow: '←', textrightarrow: '→', textuparrow: '↑', textdownarrow: '↓',
  textendash: '–', textemdash: '—', textasciitilde: '~', textasciicircum: '^', textbackslash: '\\',
  textbar: '|', textless: '<', textgreater: '>', textbraceleft: '{', textbraceright: '}',
  ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ',
  checkmark: '✓', textnumero: '№', textestimated: '℮', textbigcircle: '◯', textopenbullet: '◦',
};

class GlyphWidget extends WidgetType {
  constructor(text, svg, cmd) { super(); this.text = text; this.svg = svg; this.cmd = cmd; }
  eq(o) { return o.text === this.text && o.svg === this.svg && o.cmd === this.cmd; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-sym-glyph';
    el.title = this.cmd;
    if (this.svg) {
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(this.svg);
      const img = document.createElement('span');
      img.className = 'sym-svg';
      img.style.webkitMaskImage = img.style.maskImage = `url("${url}")`;
      el.appendChild(img);
    } else el.textContent = this.text;
    return el;
  }
  ignoreEvent() { return false; }
}

/** The symbols of one's own drawn from an SVG: name → svg. */
let svgByName = new Map();
let version = 0;
createRoot(() => createEffect(() => {
  const m = new Map();
  for (const it of mySymbols()) if (it[3] && it[3].svg) m.set(it[1].replace(/^\\/, ''), it[3].svg);
  svgByName = m;
  version++;
}));

const CMD = /\\([A-Za-z]+)(?![A-Za-z@])(\{\})?/g;

function build(view) {
  const b = new RangeSetBuilder();
  const sel = view.state.selection.ranges;
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    CMD.lastIndex = 0;
    let m;
    while ((m = CMD.exec(text))) {
      const name = m[1];
      const svg = svgByName.get(name);
      const glyph = svg ? null : TEXT_SYMBOLS[name];
      if (!svg && !glyph) continue;
      const a = from + m.index;
      const z = a + m[0].length;
      // escaped backslash (\\S is a line break and an S), a comment, or the cursor on it
      if (m.index > 0 && text[m.index - 1] === '\\') continue;
      const line = view.state.doc.lineAt(a);
      const before = line.text.slice(0, a - line.from);
      if (/(^|[^\\])%/.test(before)) continue;
      if (sel.some((r) => r.from <= z && r.to >= a)) continue;
      b.add(a, z, Decoration.replace({ widget: new GlyphWidget(glyph, svg, m[0]) }));
    }
  }
  return b.finish();
}

export const symbolRender = ViewPlugin.fromClass(class {
  constructor(view) { this.v = version; this.decorations = build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.selectionSet || this.v !== version) {
      this.v = version;
      this.decorations = build(u.view);
    }
  }
}, { decorations: (p) => p.decorations });
