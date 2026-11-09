// @vitest-environment jsdom
// The compile status shown by the status bar and by the zen-mode LED, and the
// lookup that takes a click on an error to the right file. Both are pure
// functions over plain objects; jsdom is only here because importing the
// stores reads <html data-theme> (core/state.js).
import { describe, it, expect } from 'vitest';
import { deriveCompileStatus, errorSummary, secs } from '../js/solid/stores/compileStatus.js';
import { firstError, resolveProblemFile } from '../js/solid/stores/problemsStore.js';

// A quiet application: nothing compiled, nothing running.
const idle = {
  compiling: false, compileQueued: false, compilePhase: null, compileFresh: false,
  lastCompileOk: null, compileMs: 0, kernelStatus: 'ready', liveCompile: true,
  livePending: false, pdfLoading: false, compileReason: '', liveSuspended: false,
};
const st = (over, problems) => deriveCompileStatus({ ...idle, ...over }, problems);
const kind = (over, problems) => st(over, problems).kind;

const ERR = { severity: 'error', file: 'C:\\proj\\cap1.tex', line: 42, message: 'Undefined control sequence.' };
const WARN = { severity: 'warning', file: 'C:\\proj\\main.tex', line: 7, message: 'Reference `x\' undefined' };

describe('deriveCompileStatus: one state at a time', () => {
  it('idle until something has been compiled', () => {
    expect(st({})).toEqual({ kind: 'idle', label: 'Sin compilar', detail: '' });
  });

  it('names the phase of the compile in flight', () => {
    expect(st({ compiling: true, compilePhase: 'prep' })).toMatchObject({ kind: 'latex', label: 'Preparando…' });
    expect(st({ compiling: true, compilePhase: 'python' })).toMatchObject({ kind: 'python', label: 'Ejecutando Python…' });
    expect(st({ compiling: true, compilePhase: 'latex' })).toMatchObject({ kind: 'latex', label: 'Componiendo LaTeX…' });
    expect(st({ compiling: true, compilePhase: 'pdf' })).toMatchObject({ kind: 'pdf', label: 'Cargando PDF…' });
    // An unknown or missing phase is still "compiling", never blank.
    expect(st({ compiling: true, compilePhase: null })).toMatchObject({ kind: 'latex', label: 'Compilando…' });
  });

  it('says "desde cero" for a from-scratch compile', () => {
    expect(st({ compiling: true, compilePhase: 'latex', compileFresh: true }).label).toBe('Desde cero · Componiendo LaTeX…');
  });

  it('a cell run on its own is Python too', () => {
    expect(st({ kernelStatus: 'busy' })).toMatchObject({ kind: 'python', label: 'Ejecutando Python…' });
  });

  it('the viewer loading the new PDF is its own state, after the compile ended', () => {
    expect(st({ pdfLoading: true, lastCompileOk: true })).toMatchObject({ kind: 'pdf', label: 'Cargando PDF…' });
  });

  it('a typing pause that armed the live compile shows as scheduled', () => {
    expect(kind({ livePending: true })).toBe('queued');
    // …but not when live compile is off: nothing is going to fire.
    expect(kind({ livePending: true, liveCompile: false })).toBe('idle');
    expect(kind({ compileQueued: true })).toBe('queued');
  });

  it('reports the verdicts', () => {
    expect(st({ lastCompileOk: true, compileMs: 2300 })).toEqual({ kind: 'ok', label: 'Compilado · 2,3 s', detail: '' });
    expect(st({ lastCompileOk: true })).toMatchObject({ kind: 'ok', label: 'Compilado' });
    expect(st({ lastCompileOk: 'warn' }, [ERR])).toMatchObject({ kind: 'warn', label: 'Compilado con errores' });
    expect(st({ lastCompileOk: false }, [ERR])).toMatchObject({ kind: 'error', label: 'Error de compilación' });
  });

  it('puts the first error in the detail', () => {
    const two = [WARN, ERR, { ...ERR, line: 50 }];
    expect(st({ lastCompileOk: false }, two).detail).toBe('cap1.tex L42: Undefined control sequence. (2 errores)');
  });

  it('always carries the reason there is no new PDF', () => {
    const reason = 'El motor LaTeX no respondió en 120 s.';
    expect(st({ lastCompileOk: false, compileReason: reason }, [ERR]).detail)
      .toBe(`cap1.tex L42: Undefined control sequence. · ${reason}`);
    expect(st({ lastCompileOk: false, compileReason: reason }).detail).toBe(reason);
    expect(st({ lastCompileOk: true, compileReason: 'Sin cambios desde la última compilación.' }).detail)
      .toBe('Sin cambios desde la última compilación.');
    // No verdict at all but a reason (a compile that was stopped): amber.
    expect(st({ compileReason: 'Compilación detenida.' })).toEqual({ kind: 'warn', label: 'Sin PDF nuevo', detail: 'Compilación detenida.' });
  });

  it('a warning verdict with nothing parsed still explains itself', () => {
    expect(st({ lastCompileOk: 'warn' }).detail).toMatch(/Problemas/);
  });

  it('never mentions the retired "auto-compile paused" state', () => {
    // state.liveSuspended is kept readable but is always false now; even if an
    // old code path set it, it must not surface.
    expect(st({ liveSuspended: true, lastCompileOk: true })).toMatchObject({ kind: 'ok' });
    expect(st({ liveSuspended: true })).toMatchObject({ kind: 'idle' });
  });
});

describe('deriveCompileStatus: priority', () => {
  // Every flag raised at once, then lowered one by one from the top: the
  // answer must walk down the documented order.
  const all = {
    compiling: true, compilePhase: 'python', kernelStatus: 'busy', pdfLoading: true,
    compileQueued: true, livePending: true, lastCompileOk: false, compileReason: 'motivo',
  };

  it('1. Python  2. LaTeX  3. PDF  4. queued  5. error  6. warn  7. ok  8. idle', () => {
    const seen = [];
    let s = { ...all };
    seen.push(kind(s));                                             // python
    s = { ...s, compilePhase: 'latex', kernelStatus: 'ready' };
    seen.push(kind(s));                                             // latex
    s = { ...s, compiling: false, compilePhase: null };
    seen.push(kind(s));                                             // pdf (loading)
    s = { ...s, pdfLoading: false };
    seen.push(kind(s));                                             // queued
    s = { ...s, compileQueued: false, livePending: false };
    seen.push(kind(s));                                             // error
    s = { ...s, lastCompileOk: 'warn' };
    seen.push(kind(s));                                             // warn
    s = { ...s, lastCompileOk: true };
    seen.push(kind(s));                                             // ok
    s = { ...s, lastCompileOk: null, compileReason: '' };
    seen.push(kind(s));                                             // idle
    expect(seen).toEqual(['python', 'latex', 'pdf', 'queued', 'error', 'warn', 'ok', 'idle']);
  });

  it('work in progress always beats the last verdict', () => {
    for (const last of [false, 'warn', true]) {
      expect(kind({ compiling: true, compilePhase: 'latex', lastCompileOk: last })).toBe('latex');
      expect(kind({ pdfLoading: true, lastCompileOk: last })).toBe('pdf');
      expect(kind({ livePending: true, lastCompileOk: last })).toBe('queued');
    }
  });

  it('a queued compile is mentioned while the current one runs', () => {
    expect(st({ compiling: true, compilePhase: 'latex', compileQueued: true }).detail).toMatch(/en cola/);
    expect(st({ compiling: true, compilePhase: 'latex' }).detail).toBe('');
  });
});

describe('errorSummary / firstError / secs', () => {
  it('skips warnings and bad boxes', () => {
    const list = [WARN, { severity: 'badbox', line: 3, message: 'Overfull' }, ERR];
    expect(firstError(list)).toBe(ERR);
    expect(firstError([WARN])).toBe(null);
    expect(firstError([])).toBe(null);
    expect(firstError(undefined)).toBe(null);
  });

  it('formats the location that is known', () => {
    expect(errorSummary([ERR])).toBe('cap1.tex L42: Undefined control sequence.');
    expect(errorSummary([{ severity: 'error', file: null, line: 9, message: 'x' }])).toBe('L9: x');
    expect(errorSummary([{ severity: 'error', file: null, line: null, message: 'Pyx — fallo' }])).toBe('Pyx — fallo');
    expect(errorSummary([WARN])).toBe('');
  });

  it('cuts an endless message', () => {
    const s = errorSummary([{ severity: 'error', line: 1, message: 'a'.repeat(500) }]);
    expect(s.length).toBeLessThan(180);
    expect(s.endsWith('…')).toBe(true);
  });

  it('seconds: one decimal with a comma, whole numbers from ten up', () => {
    expect(secs(2300)).toBe('2,3');
    expect(secs(1040)).toBe('1,0');
    expect(secs(80)).toBe('0,1');
    expect(secs(12_400)).toBe('12');
  });
});

describe('resolveProblemFile: which document a problem belongs to', () => {
  const documents = [
    { path: 'C:\\proj\\main.pltx', fileName: 'main.pltx' },
    { path: 'C:\\proj\\caps\\cap1.tex', fileName: 'cap1.tex' },
    { path: null, fileName: 'sin-título.pltx' },
  ];
  const ctx = {
    documents,
    projectDir: 'C:\\proj',
    knownFiles: new Set(['main.pltx', 'cap1.tex', 'cap2.tex', 'anexo.tex']),
    sourceFiles: ['C:\\proj\\main.pltx', 'C:\\proj\\caps\\cap1.tex', 'C:\\proj\\caps\\cap2.tex'],
  };

  it('a problem with no file belongs to the document in front', () => {
    expect(resolveProblemFile({ file: null, line: 3 }, ctx)).toEqual({ kind: 'active' });
    expect(resolveProblemFile(null, ctx)).toEqual({ kind: 'active' });
  });

  it('finds an open document by path, whatever the slashes or the case', () => {
    expect(resolveProblemFile({ file: 'C:\\proj\\caps\\cap1.tex' }, ctx)).toEqual({ kind: 'open', index: 1 });
    expect(resolveProblemFile({ file: 'c:/PROJ/caps/./cap1.tex' }, ctx)).toEqual({ kind: 'open', index: 1 });
  });

  it('the error is NOT in the active document: it names the chapter, not line N of main', () => {
    // The regression this exists for: an error at cap1.tex:42 used to move
    // the cursor to line 42 of whatever was in front.
    const t = resolveProblemFile({ file: 'C:\\proj\\caps\\cap1.tex', line: 42 }, ctx);
    expect(t.kind).toBe('open');
    expect(documents[t.index].fileName).toBe('cap1.tex');
  });

  it('opens a project file that is not open yet', () => {
    expect(resolveProblemFile({ file: 'C:\\proj\\caps\\cap2.tex' }, ctx)).toEqual({ kind: 'path', path: 'C:\\proj\\caps\\cap2.tex' });
  });

  it('resolves a bare name TeX printed', () => {
    expect(resolveProblemFile({ file: 'cap1.tex' }, ctx)).toEqual({ kind: 'open', index: 1 });
    expect(resolveProblemFile({ file: './caps/cap2.tex' }, ctx)).toEqual({ kind: 'path', path: 'C:\\proj\\caps\\cap2.tex' });
    // Known to the project but with no build copy recorded: relative to its folder.
    expect(resolveProblemFile({ file: 'anexo.tex' }, ctx)).toEqual({ kind: 'path', path: 'C:\\proj\\anexo.tex' });
  });

  it('prefers the open document inside the project when two share a name', () => {
    const docs = [{ path: 'D:\\otro\\main.pltx', fileName: 'main.pltx' }, ...documents];
    expect(resolveProblemFile({ file: 'main.pltx' }, { ...ctx, documents: docs })).toEqual({ kind: 'open', index: 1 });
  });

  it('does not send the cursor anywhere for an error inside a package', () => {
    expect(resolveProblemFile({ file: 'C:\\texlive\\texmf-dist\\tex\\latex\\siunitx\\siunitx.sty', line: 9 }, ctx))
      .toEqual({ kind: 'foreign' });
    expect(resolveProblemFile({ file: 'article.cls', line: 9 }, ctx)).toEqual({ kind: 'foreign' });
  });

  it('works with nothing compiled yet', () => {
    expect(resolveProblemFile({ file: 'cap1.tex' }, { documents })).toEqual({ kind: 'open', index: 1 });
    expect(resolveProblemFile({ file: 'x.tex' }, {})).toEqual({ kind: 'foreign' });
  });
});
