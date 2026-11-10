// @vitest-environment jsdom
// F10 · what a keystroke costs in a LARGE document.
//
// The work that used to ride on every key press — a second whole-document
// scan for the spell checker, a recount of the search matches, a join of
// every open document for each `\` — is measured here on a synthetic report
// of ~40 000 lines, and the structural guarantees are asserted: typing does
// not trigger those scans synchronously, and a burst of keys pays for them
// ONCE.
//
// Timings are printed (run with PYX_BENCH=1 for the table); only counts are
// asserted, because milliseconds are not stable across machines.

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CompletionContext } from '@codemirror/autocomplete';

const h = vi.hoisted(() => ({
  cellScans: 0,          // whole-document scans asked of parseCells
  docs: new Map(),       // doc id -> Text (the "editor")
  stringified: 0,        // Text → string conversions of whole documents
}));

// spellcheck.js takes parseCells from cells.js (which drags the whole cell
// runtime in). The real parser, counted: one call on a new document version
// is one whole-document scan.
vi.mock('../js/editor/cells.js', async () => {
  const real = await vi.importActual('../js/editor/cell-parse.js');
  const seen = new WeakSet();
  return {
    parseCells: (state) => {
      if (!seen.has(state.doc)) { seen.add(state.doc); h.cellScans++; }
      return real.parseCells(state);
    },
  };
});

vi.mock('../js/editor/setup.js', () => ({
  getDocContent: (id) => { h.stringified++; const t = h.docs.get(id); return t ? t.toString() : ''; },
  getDocText: (id) => h.docs.get(id) || null,
  getViewOfDoc: () => null,
  broadcastCellRefresh: () => {},
}));
vi.mock('../js/editor/cell-runner.js', () => ({
  kernelComplete: async () => null,
  linkedNames: async () => ({}),
}));
vi.mock('../js/editor/notebooks.js', () => ({
  notebookRefs: () => [], notebookPath: () => null, loadNotebook: async () => [],
  resolveLinkPath: async () => null,
}));

const BENCH = !!process.env.PYX_BENCH;
const report = [];
const note = (name, ms, extra = '') => report.push(`${name.padEnd(58)} ${ms.toFixed(2).padStart(9)} ms ${extra}`);

/** A report-sized document: sections, prose, math, display math, cells. */
function bigDocument(chapters = 400) {
  const out = [
    '\\documentclass{article}', '\\usepackage{amsmath}', '\\usepackage{graphicx}',
    '\\newcommand{\\kN}{\\,\\mathrm{kN}}', '\\newcommand{\\vect}[1]{\\mathbf{#1}}',
    '\\begin{document}',
  ];
  for (let c = 0; c < chapters; c++) {
    out.push(`\\section{Capítulo ${c}}\\label{sec:cap${c}}`);
    for (let p = 0; p < 90; p++) {
      out.push(`La viga del tramo ${p} soporta una carga distribuida y el momento flector máximo aparece en el centro del vano, véase \\ref{sec:cap${c}}.`);
      if (p % 15 === 7) out.push('\\begin{equation}', `M_{${p}} = \\frac{q L^2}{8}`, '\\end{equation}');
      if (p % 30 === 11) out.push('\\[', 'V = \\frac{q L}{2}', '\\]');
    }
    if (c % 10 === 3) out.push('%#python', 'import math', `L = ${c}.0`, 'q = 12.5', 'M = q * L**2 / 8', '%#end');
  }
  out.push('\\end{document}');
  return out.join('\n');
}

let TEXT;
beforeAll(() => {
  // CodeMirror measures the DOM; jsdom has no layout. Enough for a view to
  // run its plugins and accept transactions.
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
  }
  TEXT = bigDocument();
});

const typeChars = (view, n, at) => {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) view.dispatch({ changes: { from: at + i, insert: 'x' } });
  return (performance.now() - t0) / n;
};

describe('F10 · cost of a keystroke in a large document', () => {
  it('the spell checker does not rescan the document on every key', async () => {
    const { spellCheck } = await import('../js/editor/spellcheck.js');
    const parent = document.body.appendChild(document.createElement('div'));

    // Baseline: the same view with no spell checker — but WITH the cell scan
    // the real editor runs on every edit anyway (cells.js), so the difference
    // is what the checker itself adds.
    const { parseCells } = await vi.importActual('../js/editor/cell-parse.js');
    const cellsOnly = EditorView.updateListener.of((u) => { if (u.docChanged) parseCells(u.state); });
    const bare = new EditorView({ parent, state: EditorState.create({ doc: TEXT, extensions: [cellsOnly] }) });
    const at = TEXT.indexOf('La viga del tramo 40');
    const bareMs = typeChars(bare, 40, at);
    bare.destroy();

    const view = new EditorView({ parent, state: EditorState.create({ doc: TEXT, extensions: [cellsOnly, spellCheck] }) });
    h.cellScans = 0;
    const N = 40;
    vi.useFakeTimers();
    let perKey;
    try {
      perKey = typeChars(view, N, at);
      const duringTyping = h.cellScans;
      // Typing settled: the pending re-check runs, once.
      vi.advanceTimersByTime(1000);
      const afterPause = h.cellScans;
      note('spell: per keystroke (40 keys, ~40 000 lines)', perKey, `· sin corrector ${bareMs.toFixed(2)} ms · escaneos al teclear ${duringTyping}, tras la pausa ${afterPause}`);
      // No whole-document scan rides on a key press…
      expect(duringTyping).toBe(0);
      // …and the burst is paid for once, when typing pauses.
      expect(afterPause).toBe(1);
    } finally {
      vi.useRealTimers();
      view.destroy();
    }
  });

  it('underlines still follow the text between re-checks, and a re-check does run', async () => {
    const { spellCheck } = await import('../js/editor/spellcheck.js');
    const parent = document.body.appendChild(document.createElement('div'));
    // «la la» is a repeated word: the grammar pass underlines the second one.
    const view = new EditorView({ parent, state: EditorState.create({ doc: 'Esto es la la prueba.\nOtra línea.', extensions: [spellCheck] }) });
    const plugin = view.plugin(spellCheck);
    const marks = () => {
      const out = [];
      plugin.decorations.between(0, view.state.doc.length, (from, to) => { out.push(view.state.sliceDoc(from, to)); });
      return out;
    };
    vi.useFakeTimers();
    try {
      expect(marks().length).toBeGreaterThan(0);
      const before = marks();
      // Insert at the very start: the marks must move with their words at once.
      view.dispatch({ changes: { from: 0, insert: 'Ya: ' } });
      expect(marks()).toEqual(before);
      // Fix the repetition: after the pause the underline is gone.
      const i = view.state.doc.toString().indexOf('la la');
      view.dispatch({ changes: { from: i, to: i + 3, insert: '' } });
      vi.advanceTimersByTime(1000);
      expect(marks()).not.toEqual(before);
    } finally {
      vi.useRealTimers();
      view.destroy();
    }
  });

  it('a nested environment closing on the same line does not switch the checker off for the rest', async () => {
    const { spellCheck } = await import('../js/editor/spellcheck.js');
    const parent = document.body.appendChild(document.createElement('div'));
    const marksOf = (src) => {
      const view = new EditorView({ parent, state: EditorState.create({ doc: src, extensions: [spellCheck] }) });
      const out = [];
      view.plugin(spellCheck).decorations.between(0, src.length, (from, to) => { out.push(src.slice(from, to)); });
      view.destroy();
      return out;
    };
    const prose = 'Esto es la la prueba.';
    const expected = marksOf(prose);
    expect(expected.length).toBeGreaterThan(0);
    // \end{aligned} comes first on the line; the equation still ends there.
    expect(marksOf(`\\begin{equation}\\begin{aligned}a&=b\\end{aligned}\\end{equation}\n${prose}`)).toEqual(expected);
    expect(marksOf(`\\begin{align*}\na &= b\n\\end{split}\\end{align*}\n${prose}`)).toEqual(expected);
    // …and what is inside the environment is still skipped.
    expect(marksOf(`\\begin{equation}\nla la\n\\end{equation}\n${prose}`)).toEqual(expected);
  });

  it('a `\\` does not join and rescan every open document each time', async () => {
    const { calcCompletions } = await import('../js/editor/autocomplete.js');
    const { state: app } = await import('../js/core/state.js');
    // Three open documents: the big one being typed in, and two chapters.
    app.documents.splice(0);
    const other = Text.of(bigDocument(120).split('\n'));
    h.docs.set(1, Text.of(TEXT.split('\n')));
    h.docs.set(2, other);
    h.docs.set(3, other);
    app.documents.push({ id: 1, fileName: 'main.tex', path: null }, { id: 2, fileName: 'a.tex', path: null }, { id: 3, fileName: 'b.tex', path: null });
    app.activeIndex = 0;

    let st = EditorState.create({ doc: h.docs.get(1) });
    const at = TEXT.indexOf('La viga del tramo 40');
    const ask = async () => {
      // The user types a backslash and asks for the commands.
      st = st.update({ changes: { from: at, insert: '\\' } }).state;
      h.docs.set(1, st.doc);
      const res = await calcCompletions(new CompletionContext(st, at + 1, false));
      expect(res && res.options.length).toBeGreaterThan(100);
      return res;
    };
    await ask(); // warm-up: builds the option list once
    // Every whole-document Text → string conversion, whoever asks for it.
    const spy = vi.spyOn(Text.prototype, 'toString');
    const N = 20;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) await ask();
    const per = (performance.now() - t0) / N;
    const conversions = spy.mock.calls.length;
    spy.mockRestore();
    note('autocomplete: per `\\` (3 open documents)', per, `· conversiones de documento entero ${conversions}`);
    // Twenty backslashes in a row used to stringify 3 documents each (60).
    expect(conversions).toBeLessThanOrEqual(3);
    // The user's own commands are offered.
    const res = await ask();
    expect(res.options.some((o) => o.label === '\\kN')).toBe(true);
  });

  it('labels: the cache is the text, not its length', async () => {
    const { calcCompletions } = await import('../js/editor/autocomplete.js');
    const { state: app } = await import('../js/core/state.js');
    app.documents.splice(0);
    app.documents.push({ id: 7, fileName: 'm.tex', path: null });
    app.activeIndex = 0;
    const labelsOf = async (src) => {
      const doc = Text.of(src.split('\n'));
      h.docs.set(7, doc);
      const st = EditorState.create({ doc });
      const pos = src.indexOf('\\ref{') + 5;
      const res = await calcCompletions(new CompletionContext(st, pos, true));
      return res.options.map((o) => o.label);
    };
    vi.useFakeTimers();
    try {
      expect(await labelsOf('\\label{eq:aa}\n\\ref{}')).toEqual(['eq:aa']);
      vi.advanceTimersByTime(5000);
      // Same LENGTH, another label: the old cache (keyed by length) answered eq:aa.
      expect(await labelsOf('\\label{eq:zz}\n\\ref{}')).toEqual(['eq:zz']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the search panel recounts once per pause, not once per key', async () => {
    const { pyxSearchPanel } = await import('../js/editor/search-panel.js');
    const { search, setSearchQuery, SearchQuery } = await import('@codemirror/search');
    const parent = document.body.appendChild(document.createElement('div'));
    const view = new EditorView({ parent, state: EditorState.create({ doc: TEXT, extensions: [search({ createPanel: pyxSearchPanel })] }) });
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'viga' })) });
    const panel = pyxSearchPanel(view);
    panel.mount();
    const count = panel.dom.querySelector('.ps-count');
    expect(count.textContent).toBe('999+');
    vi.useFakeTimers();
    try {
      const fake = { docChanged: true };
      const t0 = performance.now();
      for (let i = 0; i < 40; i++) panel.update(fake);
      const per = (performance.now() - t0) / 40;
      note('search panel: per keystroke with the panel open', per);
      count.textContent = 'viejo';
      for (let i = 0; i < 40; i++) panel.update(fake);
      expect(count.textContent).toBe('viejo'); // nothing recounted yet
      vi.advanceTimersByTime(500);
      expect(count.textContent).toBe('999+');  // one recount after the pause
    } finally {
      vi.useRealTimers();
      view.destroy();
    }
  });

  it('the side panel\'s four passes do not run as one long task', async () => {
    const store = await import('../js/solid/stores/structureStore.js');
    const src = Text.of(TEXT.split('\n'));
    const time = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
    const parts = [
      time(() => store.parseTOC(src)), time(() => store.parseTodos(src)),
      time(() => store.parseIncludes(src)), time(() => store.countWords(src)),
    ];
    const total = parts.reduce((a, b) => a + b, 0);
    note('structure: the four passes run back to back', total);
    const words = store.countWords(src);

    // Scheduled: each pass in its own slice — and the word count in several —
    // so a key press can be served between them. Real timers: the slices are
    // cut by the clock.
    const slices = [];
    const realIdle = globalThis.requestIdleCallback;
    const realCancel = globalThis.cancelIdleCallback;
    globalThis.requestIdleCallback = (fn) => setTimeout(() => { slices.push(time(fn)); }, 1);
    globalThis.cancelIdleCallback = (id) => clearTimeout(id);
    try {
      store.scheduleDerived(src);
      const t0 = Date.now();
      while (store.wordCount() !== words && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 20));
      expect(store.toc().length).toBe(400);
      expect(store.wordCount()).toBe(words); // sliced or not, the same count
      expect(slices.length).toBeGreaterThanOrEqual(4);
      note('structure: the longest slice once scheduled', Math.max(...slices), `· ${slices.length} trozos`);
    } finally {
      globalThis.requestIdleCallback = realIdle;
      globalThis.cancelIdleCallback = realCancel;
      store.scheduleDerived(null);
    }
  }, 30000);

  it('prints the measurements', () => {
    if (BENCH) console.log(`\n── F10 · coste por pulsación (documento de ${TEXT.split('\n').length} líneas, ${(TEXT.length / 1e6).toFixed(1)} MB)\n${report.join('\n')}\n`);
    expect(report.length).toBeGreaterThan(0);
  });
});
