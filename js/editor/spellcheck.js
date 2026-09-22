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
import { general, setGeneral } from '../solid/stores/settingsStore.js';
import { lang } from '../core/i18n.js';
import Nspell from 'nspell';
import { WORD, isAcronym, maskLine } from './spell-mask.js';

// Dispatched to force a re-scan (dictionary finished loading, or a setting
// changed). Carries no data.
export const spellRefresh = StateEffect.define();

/* ---------------- dictionary (lazy, per language) ----------------
   The dictionary follows the proofing language (Configuración → Editor), which
   defaults to the UI language. It used to be hard-wired to Spanish, so an
   English document had every single word underlined.

   A language whose dictionary is not installed simply turns spell-checking off
   for that language instead of failing: drop `public/dict/<lang>.aff` and
   `.dic` in and it starts working, no code change. */
const spellers = new Map();  // lang -> Nspell | null
const building = new Map();  // lang -> Promise

export function spellLang() {
  return general.spellLang || (lang() === 'en' ? 'en' : 'es');
}
let speller = null;          // the active language's speller, or null

/** `dict/<code>.extra.txt` — a hand-maintained technical word list layered on
 *  top of the Hunspell dictionary. No general dictionary carries `flector`,
 *  `hiperestático`, `rebar` or `subgrade`, and an engineering document is full
 *  of them: without this, a calculation report comes out with half a page
 *  underlined and the checker stops being read at all. Optional — a language
 *  without one just gets the plain dictionary. */
function loadExtra(code) {
  return fetch(`dict/${code}.extra.txt`)
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => '');
}

function loadDict(code) {
  if (spellers.has(code)) return Promise.resolve(spellers.get(code));
  if (!building.has(code)) {
    building.set(code, Promise.all([
      fetch(`dict/${code}.aff`).then((r) => (r.ok ? r.text() : Promise.reject(r.status))),
      fetch(`dict/${code}.dic`).then((r) => (r.ok ? r.text() : Promise.reject(r.status))),
      loadExtra(code),
    ])
      .then(([aff, dic, extra]) => {
        const s = Nspell(aff, dic);
        const words = extra.split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'));
        // One at a time: a malformed line must not cost us the whole list.
        for (const w of words) {
          try { s.add(w); } catch (_) { /* skip that word */ }
        }
        spellers.set(code, s);
        return s;
      })
      .catch(() => { spellers.set(code, null); return null; }));
  }
  return building.get(code);
}

export function buildSpeller() {
  const code = spellLang();
  if (spellers.has(code)) {
    speller = spellers.get(code);
    return Promise.resolve(speller);
  }
  return loadDict(code).then((s) => {
    // A late-arriving dictionary must not clobber a language the user switched
    // away from meanwhile.
    if (spellLang() === code) { speller = s; cache.clear(); }
    return s;
  });
}
export function spellerReady() { return !!speller; }

/** Switch proofing language: swap the active dictionary and drop the word
 *  cache (a word correct in one language rarely is in the other).
 *
 *  Resolves once the new dictionary is loaded, so the caller can repaint THEN
 *  — repainting immediately would just re-underline everything with the old
 *  dictionary still in place. */
export function setSpellLang(code) {
  setGeneral({ spellLang: code });
  speller = spellers.get(code) || null;
  cache.clear();
  return buildSpeller();
}

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

// word -> correct? Bounded: a long editing session over a big document would
// otherwise keep one entry per distinct word form seen, forever.
const cache = new Map();
const WORD_CACHE_MAX = 20000;
function isCorrect(word) {
  if (userWords.has(word) || userWords.has(word.toLowerCase())) return true;
  if (cache.has(word)) return cache.get(word);
  let ok = true;
  try { ok = speller ? speller.correct(word) : true; } catch (_) { ok = true; }
  if (cache.size >= WORD_CACHE_MAX) cache.clear();
  cache.set(word, ok);
  return ok;
}
export function spellSuggest(word) {
  if (!speller || !word) return [];
  try { return speller.suggest(word).slice(0, 8); } catch (_) { return []; }
}

/* ---------------- masking out non-prose ----------------
   The rules themselves live in `spell-mask.js`: pure string work, no editor,
   so they can be tested directly. */

/* ---------------- multi-line skip ranges (memoized per doc) ----------------
   Regions the checker must ignore: Python cells, math environments and display
   math. Computed once per document version and bisected afterwards.

   This used to materialize the whole document (`doc.toString()`) and run two
   global regexes over it on every keystroke — tens of megabytes allocated per
   character on a big project, which is exactly what made large files unusable.
   It now streams the rope line by line with a small state machine: one linear
   pass, nothing allocated beyond a line, and no arbitrary size cap. */
const MATH_ENVS = new Set(['equation', 'align', 'gather', 'multline', 'displaymath',
  'eqnarray', 'math', 'flalign', 'alignat', 'verbatim', 'lstlisting', 'minted']);
const BEGIN_RE = /\\begin\s*\{([A-Za-z]+)\*?\}/;
const END_RE = /\\end\s*\{([A-Za-z]+)\*?\}/;

const skipCache = new WeakMap();
function skipRanges(state) {
  const doc = state.doc;
  const hit = skipCache.get(doc);
  if (hit) return hit;

  const ranges = [];
  for (const c of parseCells(state)) {
    ranges.push([doc.line(c.headerLine).from, doc.line(c.endLine).to]);
  }

  // Single streaming pass for math environments and \[ … \] display math.
  let pos = 0;              // absolute offset of the current line's start
  let env = null;           // open math environment name, if any
  let envStart = 0;
  let dispStart = -1;       // offset of an open \[ that hasn't closed yet
  for (const text of doc.iterLines()) {
    const end = pos + text.length;
    // Cheap reject: none of these constructs can occur without a backslash.
    if (text.indexOf('\\') >= 0) {
      let i = 0; // scan cursor within this line
      while (i <= text.length) {
        if (env) {
          const m = END_RE.exec(text.slice(i));
          if (!m || m[1] !== env) break;   // still inside the environment
          ranges.push([envStart, pos + i + m.index + m[0].length]);
          env = null;
          i += m.index + m[0].length;
          continue;
        }
        if (dispStart >= 0) {
          const close = text.indexOf('\\]', i);
          if (close < 0) break;            // display math continues on the next line
          ranges.push([dispStart, pos + close + 2]);
          dispStart = -1;
          i = close + 2;
          continue;
        }
        const rest = text.slice(i);
        const b = BEGIN_RE.exec(rest);
        const open = rest.indexOf('\\[');
        // Whichever construct opens first on this line wins.
        const bAt = b && MATH_ENVS.has(b[1]) ? b.index : -1;
        if (bAt < 0 && open < 0) break;
        if (bAt >= 0 && (open < 0 || bAt < open)) {
          env = b[1];
          envStart = pos + i + bAt;
          i += bAt + b[0].length;
        } else {
          dispStart = pos + i + open;
          i += open + 2;
        }
      }
    }
    pos = end + 1; // +1 for the line break
  }
  // Unterminated constructs run to the end of the document.
  if (env) ranges.push([envStart, doc.length]);
  if (dispStart >= 0) ranges.push([dispStart, doc.length]);

  // Merge overlaps: `inSkip` bisects, which is only correct on a set of
  // DISJOINT ranges. Cell bodies and math regions can overlap (a cell that
  // prints LaTeX, say), and an overlap made the bisect miss real hits.
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  skipCache.set(doc, merged);
  return merged;
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
        // Build the dictionary lazily; repaint once it's ready. A language with
        // no dictionary installed resolves to null and simply stays quiet.
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
