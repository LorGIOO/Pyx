// Word-style proofing for the LaTeX prose: Hunspell spell-checking (red wavy
// underline + right-click suggestions, the same dictionary family Word/
// LibreOffice/Firefox use) and a lightweight local grammar pass (blue wavy
// underline, e.g. repeated words) — fully offline, Spanish (es).
//
// Only PROSE is checked: LaTeX command names, command arguments that aren't
// text (\ref, \label, \cite, \includegraphics…), math ($…$, \[…\], equation/
// align…), comments, verbatim and Python cells are masked out so they never
// produce false errors.

import { ViewPlugin, Decoration } from '@codemirror/view';
import { RangeSetBuilder, StateEffect } from '@codemirror/state';
import { parseCells } from './cells.js';
import { general } from '../solid/stores/settingsStore.js';
import Nspell from 'nspell';

// Dispatched to force a re-scan (dictionary finished loading, or a setting
// changed). Carries no data.
export const spellRefresh = StateEffect.define();

/* ---------------- dictionary (lazy, once) ---------------- */
let speller = null;
let building = null;
export function buildSpeller() {
  if (speller) return Promise.resolve(speller);
  if (!building) {
    building = Promise.all([
      fetch('/dict/es.aff').then((r) => r.text()),
      fetch('/dict/es.dic').then((r) => r.text()),
    ])
      .then(([aff, dic]) => { speller = Nspell(aff, dic); return speller; })
      .catch(() => null);
  }
  return building;
}
export function spellerReady() { return !!speller; }

/* ---------------- personal dictionary ---------------- */
const userWords = (() => {
  try { return new Set(JSON.parse(localStorage.getItem('pyx-userdict') || '[]')); }
  catch (_) { return new Set(); }
})();
function saveUserWords() {
  try { localStorage.setItem('pyx-userdict', JSON.stringify([...userWords])); } catch (_) {}
}
export function addToUserDict(word) {
  if (!word) return;
  userWords.add(word);
  cache.delete(word);
  saveUserWords();
}

const cache = new Map(); // word -> correct?
function isCorrect(word) {
  if (userWords.has(word) || userWords.has(word.toLowerCase())) return true;
  if (cache.has(word)) return cache.get(word);
  let ok = true;
  try { ok = speller ? speller.correct(word) : true; } catch (_) { ok = true; }
  cache.set(word, ok);
  return ok;
}
export function spellSuggest(word) {
  if (!speller || !word) return [];
  try { return speller.suggest(word).slice(0, 8); } catch (_) { return []; }
}

/* ---------------- masking out non-prose ---------------- */
// Word = a run of letters (incl. accents); checked only when it has ≥2 letters,
// isn't ALL-CAPS (acronym) and has no digits.
const WORD = /\p{L}[\p{L}\p{M}]*/gu;
const isAcronym = (w) => w === w.toUpperCase() && w.length <= 6;

// Commands whose {argument} is NOT prose (identifiers, keys, paths, code).
const NOPROSE = new RegExp(
  '\\\\(?:' +
  'ref|eqref|pageref|autoref|nameref|cref|Cref|label|cite[a-zA-Z]*|' +
  'input|include|includegraphics|includepdf|usepackage|documentclass|' +
  'bibliography|bibliographystyle|addbibresource|url|href|hyperref|' +
  'begin|end|py|pyfile|color|textcolor|definecolor|pagestyle|thispagestyle|' +
  'newcommand|renewcommand|providecommand|def|let|graphicspath|geometry|' +
  'setlength|setcounter|usetikzlibrary|lstinputlisting|verb|lstset' +
  ')\\*?\\s*(?:\\[[^\\]]*\\])?\\s*(?:\\{[^{}]*\\})?',
  'g'
);

// Replace a slice with spaces so character offsets stay aligned with the line.
function blank(s, re) {
  return s.replace(re, (m) => ' '.repeat(m.length));
}
// Mask one line's non-prose so the leftover is pure text at the same offsets.
function maskLine(text) {
  let t = text;
  // Comment: from an unescaped % to end of line.
  const cm = t.replace(/\\%/g, '  ').indexOf('%');
  if (cm >= 0) t = t.slice(0, cm) + ' '.repeat(t.length - cm);
  t = blank(t, /\\\([^)]*?\\\)/g);         // inline math \(…\)
  t = blank(t, /\\verb\*?(.).*?\1/g);      // inline verbatim \verb|…|
  t = blank(t, /\$[^$]*\$/g);              // inline math $…$
  t = blank(t, NOPROSE);                   // \ref{…}, \cite{…}, \py{…}, …
  t = blank(t, /\\[a-zA-Z@]+\*?/g);        // remaining command NAMES
  t = blank(t, /\[[^\[\]]*\]/g);           // optional args / options: [on] [off] [draft] [key=val]
  t = blank(t, /\\[^a-zA-Z]/g);            // \%, \&, \\, \_ …
  return t;
}

/* ---------------- multi-line skip ranges (memoized per doc) ---------------- */
const MATH_ENVS = ['equation', 'align', 'gather', 'multline', 'displaymath',
  'eqnarray', 'math', 'flalign', 'alignat', 'verbatim', 'lstlisting', 'minted'];
const skipCache = new WeakMap();
function skipRanges(state) {
  const doc = state.doc;
  const hit = skipCache.get(doc);
  if (hit) return hit;
  const ranges = [];
  for (const c of parseCells(state)) {
    ranges.push([doc.line(c.headerLine).from, doc.line(c.endLine).to]);
  }
  // Cap the full-text scan so very large documents stay snappy.
  if (doc.length < 2_000_000) {
    const text = doc.toString();
    const envRe = new RegExp(
      `\\\\begin\\{(${MATH_ENVS.map((e) => e + '\\*?').join('|')})\\}[\\s\\S]*?\\\\end\\{\\1\\}`, 'g');
    let m;
    while ((m = envRe.exec(text))) ranges.push([m.index, m.index + m[0].length]);
    const disp = /\\\[[\s\S]*?\\\]/g;
    while ((m = disp.exec(text))) ranges.push([m.index, m.index + m[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  skipCache.set(doc, ranges);
  return ranges;
}
function inSkip(ranges, pos) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, r = ranges[mid];
    if (pos < r[0]) hi = mid - 1;
    else if (pos > r[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/* ---------------- the word at a position (for the context menu) ---------------- */
export function spellInfoAt(view, pos) {
  if (general.spellCheck === false || !speller) return null;
  const line = view.state.doc.lineAt(pos);
  if (inSkip(skipRanges(view.state), pos)) return null;
  const masked = maskLine(line.text);
  WORD.lastIndex = 0;
  let m;
  while ((m = WORD.exec(masked))) {
    const from = line.from + m.index, to = from + m[0].length;
    if (pos < from || pos > to) continue;
    const w = m[0];
    if (w.length < 2 || isAcronym(w) || isCorrect(w)) return null;
    return { word: w, from, to, suggestions: spellSuggest(w) };
  }
  return null;
}

/* ---------------- decorations ---------------- */
const SPELL = Decoration.mark({ class: 'cm-spell-bad' });
const GRAMMAR = Decoration.mark({ class: 'cm-grammar-bad' });

function buildDecos(view) {
  const spell = general.spellCheck !== false && speller;
  const grammar = general.grammarCheck !== false;
  if (!spell && !grammar) return Decoration.none;

  const skips = skipRanges(view.state);
  const marks = []; // {from,to,deco}
  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    let ln = view.state.doc.lineAt(vFrom).number;
    const lastLn = view.state.doc.lineAt(vTo).number;
    for (; ln <= lastLn; ln++) {
      const line = view.state.doc.line(ln);
      if (!line.text || inSkip(skips, line.from)) continue;
      const masked = maskLine(line.text);

      if (spell) {
        WORD.lastIndex = 0;
        let m;
        while ((m = WORD.exec(masked))) {
          const w = m[0];
          if (w.length < 2 || isAcronym(w) || /\d/.test(w)) continue;
          const from = line.from + m.index;
          if (inSkip(skips, from)) continue;
          if (!isCorrect(w)) marks.push({ from, to: from + w.length, deco: SPELL });
        }
      }
      if (grammar) {
        // Repeated word ("el el") — Word-style blue underline on the second one.
        const rep = /\b(\p{L}{3,})(\s+)(\1)\b/giu;
        let g;
        while ((g = rep.exec(masked))) {
          const from = line.from + g.index + g[1].length + g[2].length;
          marks.push({ from, to: from + g[3].length, deco: GRAMMAR });
        }
      }
    }
  }
  marks.sort((a, b) => a.from - b.from || a.to - b.to);
  const b = new RangeSetBuilder();
  for (const mk of marks) b.add(mk.from, mk.to, mk.deco);
  return b.finish();
}

export const spellCheck = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.decorations = buildDecos(view);
      if ((general.spellCheck !== false) && !speller) {
        // Build the dictionary lazily; repaint once it's ready.
        buildSpeller().then((s) => {
          if (s && !this.disposed) this.view.dispatch({ effects: spellRefresh.of(null) });
        });
      }
    }
    update(u) {
      const refresh = u.transactions.some((t) => t.effects.some((e) => e.is(spellRefresh)));
      if (u.docChanged || u.viewportChanged || refresh) {
        this.decorations = buildDecos(u.view);
      }
    }
    destroy() { this.disposed = true; }
  },
  { decorations: (v) => v.decorations }
);
