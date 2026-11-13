// The compile's state machine, end to end, with the engine and the viewer
// replaced by doubles: what the user sees when compiles come in bursts, when
// the engine writes no PDF, and when the viewer does not answer.
//
// The rule under test is TeXstudio's: every compile that is asked for ends in
// a new PDF on screen or in a reason — never in "Compilando…" for ever, and
// never in "done" over an old PDF.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fs = new Map(); // path -> { content, mtime }
let clock = 1000;
const put = (path, content) => fs.set(path, { content, mtime: ++clock });
const WORK = 'C:/work/main-0001';
const ROOT = 'C:/proj/main.tex';

// What the "engine" was asked to compile, in order, and how it should answer.
const engine = { calls: [], ms: 20, answer: null, hang: false };
const viewer = { loads: [], hang: false, fail: null };
let docText = '';
let kernelBusy = false;

vi.mock('../js/core/platform.js', () => ({
  isTauri: () => true,
  writeTextFile: async (p, c) => { put(p, c); },
  readTextFile: async (p) => { if (!fs.has(p)) throw new Error('no existe'); return fs.get(p).content; },
  readDir: async () => [],
  pathExists: async (p) => fs.has(p),
  fileStamps: async (paths) => paths.map((p) => (fs.has(p)
    ? { mtime: fs.get(p).mtime, size: fs.get(p).content.length } : { mtime: -1, size: -1 })),
  buildDirFor: async () => WORK,
  createDir: async () => {},
  readSources: async (paths) => paths.map(() => null),
  pltxRead: async () => ({ is_zip: false }),
  emitToWindow: () => {},
  compileCancel: vi.fn(async () => true),
  kernelExec: async () => ({}),
  kernelStart: async () => ({}),
  kernelReset: async () => ({}),
  kernelSetPython: async () => ({}),
  kernelInterrupt: vi.fn(async () => {}),
  readNotebook: async () => [],
  compileLatex: vi.fn(async (path, cwd, eng, passes, job, dirs, clean, warm, prewarm, gen) => {
    const text = fs.get(path).content;
    engine.calls.push({ text, warm, prewarm, gen, clean });
    if (engine.hang) await new Promise(() => {});
    await new Promise((r) => setTimeout(r, engine.ms));
    const pdf = `${WORK}/main.pdf`;
    const base = {
      ok: true, pdf_path: pdf, log: `===== Pasada 1 (xelatex) =====\n${text}\n`, engine: eng, stopped: null,
      inputs: [], started_ms: Date.now(), gen, outcome: 'pdf', reason: '',
      pdf: { path: `${WORK}/_pyxview/main.${gen}.pdf`, size: 10, mtime: 1 },
      timings: { wait_ms: 0, prep_ms: 1, passes_ms: [engine.ms], tools_ms: 0, finish_ms: 1, total_ms: engine.ms, warm },
    };
    const res = engine.answer ? { ...base, ...engine.answer(text, gen) } : base;
    if (res.pdf_path) put(pdf, `PDF de: ${text}`);
    return res;
  }),
}));
vi.mock('../js/editor/setup.js', () => ({
  getDocContent: () => docText,
  getViewOfDoc: () => null,
}));
vi.mock('../js/editor/cells.js', () => ({ execCellFor: async () => ({ ok: true }) }));
vi.mock('../js/editor/py-ghost.js', () => ({ setScopedValues: () => {}, refreshGhostIn: () => {} }));
vi.mock('../js/pdf/preview.js', () => ({
  getPdfPath: () => (viewer.loads.length ? viewer.loads[viewer.loads.length - 1].path : null),
  loadPdf: vi.fn(async (path) => {
    const shown = fs.get(path) ? fs.get(path).content : null;
    viewer.loads.push({ path, shown });
    if (viewer.hang) await new Promise(() => {});
    if (viewer.fail) throw new Error(viewer.fail);
    return { readMs: 1, parseMs: 2, painted: Promise.resolve(7) };
  }),
}));
vi.mock('../js/solid/stores/previewStore.js', () => ({ auxOpen: () => false, lastArea: () => 'pdf' }));
vi.mock('../js/solid/stores/docStore.js', () => ({
  saveActiveAs: async () => false,
  saveWithEncoding: async (p, c) => { put(p, c); },
  markSavedIfUnchanged: (doc, text) => { doc.modified = text !== docText; return !doc.modified; },
}));
vi.mock('../js/solid/stores/settingsStore.js', () => ({
  general: { liveDelay: 300, warmEngine: true, pdfFollowCursor: false, cellTimeout: 0 },
  setGeneral: () => {},
}));
vi.mock('../js/compile/build-maps.js', () => ({
  setBuildMaps: () => {}, persistBuildMaps: async () => {}, ensureBuildMaps: async () => false,
}));
vi.mock('../js/editor/cell-runner.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    interruptKernel: vi.fn(async () => {}),
    withKernelLock: (fn) => (kernelBusy ? new Promise(() => {}) : real.withKernelLock(fn)),
  };
});

const { state } = await import('../js/core/state.js');
const compiler = await import('../js/compile/compiler.js');
const platform = await import('../js/core/platform.js');
const { compileActive, scheduleLiveCompile, cancelCompile, liveDelay } = compiler;

const doc = (body) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settled(ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!state.compiling && !state.compileQueued && !state.pdfLoading && !state.livePending) return;
    await sleep(5);
  }
  throw new Error(`no terminó: compiling=${state.compiling} queued=${state.compileQueued} pdfLoading=${state.pdfLoading} live=${state.livePending}`);
}
const edit = (body) => { docText = doc(body); state.documents[0].modified = true; };

beforeEach(async () => {
  await settled().catch(() => {});
  fs.clear();
  engine.calls.length = 0; engine.ms = 20; engine.answer = null; engine.hang = false;
  viewer.loads.length = 0; viewer.hang = false; viewer.fail = null;
  kernelBusy = false;
  platform.compileLatex.mockClear();
  state.documents = [{ id: 1, fileName: 'main.tex', path: ROOT, modified: false, engine: 'xelatex' }];
  state.activeIndex = 0;
  state.liveCompile = true;
  state.compileReason = '';
  state.lastLog = '';
  docText = doc('inicio');
  put(ROOT, docText);
});

describe('una compilación termina en un PDF nuevo o en un motivo', () => {
  it('compila y muestra el texto que hay en pantalla', async () => {
    edit('GEN 1');
    await compileActive(true);
    await settled();
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0].text).toContain('GEN 1');
    expect(viewer.loads.at(-1).shown).toContain('GEN 1');
    expect(state.lastCompileOk).toBe(true);
    expect(state.compileReason).toBe('');
    expect(state.lastLog).toContain('Tiempos de Pyx');
    expect(state.lastLog).toContain('Visor PDF');
  });

  it('50 pulsaciones seguidas de Compilar: la última versión del texto es la que queda en pantalla', async () => {
    for (let n = 1; n <= 50; n++) {
      edit(`GEN ${n}`);
      compileActive(true); // not awaited: a burst
      if (n % 7 === 0) await sleep(3);
    }
    await settled();
    // Folded: far fewer engine runs than requests, never two at once…
    expect(engine.calls.length).toBeGreaterThanOrEqual(2);
    expect(engine.calls.length).toBeLessThan(50);
    // …and the last one compiled, and the viewer shows, the last text typed.
    expect(engine.calls.at(-1).text).toContain('GEN 50');
    expect(viewer.loads.at(-1).shown).toContain('GEN 50');
    expect(state.compiling).toBe(false);
    expect(state.compileQueued).toBe(false);
  });

  it('1000 compilaciones una tras otra: las 1000 compilan y las 1000 se muestran', async () => {
    engine.ms = 0;
    for (let n = 1; n <= 1000; n++) {
      edit(`GEN ${n}`);
      await compileActive(true);
      expect(engine.calls.at(-1).text, `ronda ${n}`).toContain(`GEN ${n}\n`);
      expect(viewer.loads.at(-1).shown, `ronda ${n}`).toContain(`GEN ${n}\n`);
      expect(state.compiling).toBe(false);
    }
    expect(engine.calls).toHaveLength(1000);
    expect(viewer.loads).toHaveLength(1000);
    await settled();
  }, 60000);

  it('sin PDF: se dice por qué, en el estado y en el registro', async () => {
    engine.answer = () => ({
      ok: false, pdf_path: null, pdf: null, outcome: 'sin-pdf',
      reason: 'El PDF anterior no se puede sustituir: lo tiene abierto otro programa.',
    });
    edit('GEN 1');
    await compileActive(true);
    await settled();
    expect(state.lastCompileOk).toBe(false);
    expect(state.compileReason).toContain('otro programa');
    expect(state.lastLog).toContain('[PDF] No hay PDF nuevo');
    expect(viewer.loads).toHaveLength(0);
    // …and the next compile is a normal one.
    engine.answer = null;
    edit('GEN 2');
    await compileActive(true);
    await settled();
    expect(state.compileReason).toBe('');
    expect(viewer.loads.at(-1).shown).toContain('GEN 2');
  });

  it('un error al lanzar el motor es un motivo, no un «Compilando…» eterno', async () => {
    platform.compileLatex.mockImplementationOnce(async () => { throw new Error('No se encontró el motor «xelatex».'); });
    edit('GEN 1');
    await compileActive(true);
    await settled();
    expect(state.compiling).toBe(false);
    expect(state.lastCompileOk).toBe(false);
    expect(state.compileReason).toContain('xelatex');
  });
});

describe('el visor no retiene a la compilación', () => {
  it('con el visor atascado, la compilación termina y la siguiente arranca', async () => {
    viewer.hang = true;
    edit('GEN 1');
    await compileActive(true);
    expect(state.compiling).toBe(false); // done when the ENGINE is done
    expect(state.pdfLoading).toBe(true);
    viewer.hang = false;
    edit('GEN 2');
    await compileActive(true);
    await settled();
    expect(engine.calls).toHaveLength(2);
    expect(viewer.loads.at(-1).shown).toContain('GEN 2');
    expect(state.pdfLoading).toBe(false);
  });

  it('si el visor falla, se dice y el registro del motor no se pierde', async () => {
    viewer.fail = 'Invalid PDF structure';
    edit('GEN 1');
    await compileActive(true);
    await settled();
    expect(state.lastCompileOk).toBe(false);
    expect(state.compileReason).toContain('Invalid PDF structure');
    expect(state.lastLog).toContain('[Visor]');
    expect(state.lastLog).toContain('Pasada 1');
  });
});

describe('compilación al escribir', () => {
  it('dispara poco después de la última pulsación, una vez', async () => {
    for (let n = 1; n <= 5; n++) { edit(`GEN ${n}`); scheduleLiveCompile(); await sleep(20); }
    expect(state.livePending).toBe(true);
    expect(engine.calls).toHaveLength(0);
    await sleep(liveDelay() + 150);
    await settled();
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0].text).toContain('GEN 5');
    expect(state.livePending).toBe(false);
  });

  it('una compilación lenta de Python o del visor no alarga la espera', async () => {
    const before = liveDelay();
    viewer.hang = true; // the old code waited 20 s for the viewer and tripled it
    edit('GEN 1');
    await compileActive(true);
    expect(liveDelay()).toBe(before);
    viewer.hang = false;
  });

  it('un motor lento alarga la espera, pero nunca más de 10 s ni la suspende', async () => {
    engine.ms = 700;
    edit('GEN 1');
    await compileActive(true);
    await settled();
    expect(liveDelay()).toBeGreaterThanOrEqual(650);
    expect(liveDelay()).toBeLessThanOrEqual(10000);
    expect(compiler.liveCompileSuspended()).toBe(false);
    engine.ms = 0;
    edit('GEN 2');
    await compileActive(true);
    await settled();
    expect(liveDelay()).toBe(300);
  });

  it('si salta con una compilación en curso, se encola en vez de rearmarse', async () => {
    engine.ms = 500;
    edit('GEN 1');
    const first = compileActive(true);
    await sleep(30);
    edit('GEN 2');
    scheduleLiveCompile();
    await sleep(liveDelay() + 60); // the timer fired while GEN 1 was compiling
    expect(state.livePending).toBe(false);
    expect(state.compileQueued).toBe(true);
    await first;
    await settled();
    expect(engine.calls.at(-1).text).toContain('GEN 2');
  });

  // The paused engine serves every compile but the one that starts from
  // nothing: "Compilar y ver" used to be kept from it, and on a document with
  // a heavy preamble it was the one compile that paid for all of it (7 s of a
  // 17 s pass, measured), every time the button was pressed.
  it('el motor en espera sirve a «Compilar» y al segundo plano; «desde cero» nunca', async () => {
    edit('GEN 1');
    await compileActive(true);
    edit('GEN 2');
    await compileActive(false);
    await settled();
    edit('GEN 3');
    await compileActive(true, { fresh: true });
    await settled();
    expect(engine.calls[0]).toMatchObject({ warm: true, prewarm: true });
    expect(engine.calls[1]).toMatchObject({ warm: true, prewarm: true });
    expect(engine.calls[2]).toMatchObject({ warm: false, clean: true });
    expect(engine.calls[1].gen).toBeGreaterThan(engine.calls[0].gen);
  });

  it('sin cambios, en segundo plano no se vuelve a lanzar el motor', async () => {
    edit('GEN 1');
    await compileActive(true);
    await settled();
    await compileActive(false);
    await settled();
    expect(engine.calls).toHaveLength(1);
    expect(state.compileReason).toBe('');
    // A manual one always runs the engine: it is the ground truth.
    await compileActive(true);
    await settled();
    expect(engine.calls).toHaveLength(2);
  });
});

describe('nunca se queda en «Compilando…»', () => {
  it('un paso que no vuelve nunca se abandona con un motivo, y se puede compilar otra vez', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    try {
      engine.hang = true; // the engine's IPC call is never answered
      edit('GEN 1');
      compileActive(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.compiling).toBe(true); // a slow engine is not a stuck one
      expect(state.compilePhase).toBe('latex');
      edit('GEN 2');
      compileActive(true); // queued behind the stuck one
      expect(state.compileQueued).toBe(true);
      engine.hang = false;
      await vi.advanceTimersByTimeAsync(81 * 60_000);
      expect(platform.compileCancel).toHaveBeenCalled();
      // The stuck run was abandoned, with its reason in the log…
      expect(engine.calls[0].text).toContain('GEN 1');
      // …and what was queued behind it ran, and is what is on screen.
      await vi.advanceTimersByTimeAsync(1000);
      expect(engine.calls.at(-1).text).toContain('GEN 2');
      expect(viewer.loads.at(-1).shown).toContain('GEN 2');
      expect(state.compiling).toBe(false);
      expect(state.compileQueued).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandonar deja el motivo a la vista cuando no hay nada encolado', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    try {
      engine.hang = true;
      edit('GEN 1');
      compileActive(true);
      await vi.advanceTimersByTimeAsync(81 * 60_000);
      expect(state.compiling).toBe(false);
      expect(state.lastCompileOk).toBe(false);
      expect(state.compileReason).toContain('abandonó');
      expect(state.lastLog).toContain('abandonó');
    } finally {
      engine.hang = false;
      vi.useRealTimers();
    }
  });
});

describe('detener', () => {
  it('detiene, descarta lo encolado y deja compilar de nuevo', async () => {
    engine.ms = 300;
    engine.answer = () => ({ ok: false, pdf_path: null, pdf: null, stopped: 'cancelado', outcome: 'detenido', reason: 'Compilación detenida por el usuario.' });
    edit('GEN 1');
    const run = compileActive(true);
    await sleep(30);
    edit('GEN 2');
    compileActive(true);
    scheduleLiveCompile();
    await cancelCompile();
    await run;
    await settled();
    expect(platform.compileCancel).toHaveBeenCalled();
    expect(engine.calls).toHaveLength(1); // the queued one did not run
    expect(state.compileReason).toContain('detenida');
    engine.answer = null; engine.ms = 5;
    edit('GEN 3');
    await compileActive(true);
    await settled();
    expect(viewer.loads.at(-1).shown).toContain('GEN 3');
  });
});
