// What the compile is doing, in one place.
//
// The status bar, the ribbon button and (in zen mode, where neither of those
// is on screen) the compile LED all have to answer the same question — is it
// compiling, did it work, and if not, why. Each used to read `state.compiling`
// and friends on its own; this derives ONE answer so they cannot disagree.
//
//   compileStatus() -> { kind, label, detail }
//
//   kind    python | latex | pdf | queued | error | warn | ok | idle
//   label   a few words: "Componiendo LaTeX…", "Compilado · 2,3 s"
//   detail  the longer part, for a tooltip: the first error, or why there is
//           no new PDF ('' when there is nothing to add)

import { createRoot, createMemo } from 'solid-js';
import { state } from '../../core/state.js';
import { t } from '../../core/i18n.js';
import { problems, firstError } from './problemsStore.js';

// What the compile in flight is doing right now. "Compilando…" alone gave no
// clue whether a slow compile was waiting on a Python cell or on LaTeX — and
// those have different cures (a heavy cell vs. a heavy document).
export const phaseLabel = () => ({
  prep: t('Preparando…', 'Preparing…'),
  python: t('Ejecutando Python…', 'Running Python…'),
  latex: t('Componiendo LaTeX…', 'Typesetting LaTeX…'),
  pdf: t('Cargando PDF…', 'Loading PDF…'),
});

/** Milliseconds as seconds for display: one decimal under 10 s ("2,3"). */
export const secs = (ms) => (ms >= 10_000
  ? String(Math.round(ms / 1000))
  : (ms / 1000).toFixed(1).replace('.', t(',', '.')));

const fileBase = (f) => (f ? String(f).split(/[\\/]/).pop() : '');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * The first error of a problem list as one line:
 * "L42: Undefined control sequence (3 errores)". '' when there is none.
 */
export function errorSummary(list) {
  const p = firstError(list);
  if (!p) return '';
  const n = list.filter((x) => x && x.severity === 'error').length;
  const loc = [fileBase(p.file), p.line ? `L${p.line}` : ''].filter(Boolean).join(' ');
  const more = n > 1 ? ` (${n} ${t('errores', 'errors')})` : '';
  return `${loc ? `${loc}: ` : ''}${clip(String(p.message || ''), 160)}${more}`;
}

/**
 * Pure: the status for a snapshot of the compile fields of `state`.
 *
 * The ORDER of the tests is the point. Something happening now always beats
 * the verdict of the last compile (a red LED while the fix is being compiled
 * would be a lie), and among the things happening, the one the user is
 * actually waiting on comes first:
 *
 *   1. Python running   2. LaTeX compiling   3. the viewer loading the PDF
 *   4. a compile queued or armed by a typing pause
 *   5. error   6. warning   7. success   8. nothing yet
 */
export function deriveCompileStatus(s, list = []) {
  const fresh = s.compileFresh ? t('Desde cero · ', 'From scratch · ') : '';
  const queuedNote = s.compileQueued
    ? t('Hay otra compilación en cola: empezará al terminar esta, con lo último que hayas escrito.',
      'Another compile is queued: it starts when this one ends, with your latest text.')
    : '';

  // 1. Python — a compile in its Python phase, or a cell run on its own.
  if ((s.compiling && s.compilePhase === 'python') || s.kernelStatus === 'busy') {
    return { kind: 'python', label: (s.compiling ? fresh : '') + phaseLabel().python, detail: s.compiling ? queuedNote : '' };
  }
  // 2. LaTeX (and the short phases around it).
  if (s.compiling) {
    return {
      kind: s.compilePhase === 'pdf' ? 'pdf' : 'latex',
      label: fresh + (phaseLabel()[s.compilePhase] || t('Compilando…', 'Compiling…')),
      detail: queuedNote,
    };
  }
  // 3. The engine is done; the viewer is loading what it wrote.
  if (s.pdfLoading) return { kind: 'pdf', label: phaseLabel().pdf, detail: '' };
  // 4. Not started yet, but about to.
  if (s.compileQueued || (s.livePending && s.liveCompile !== false)) {
    return {
      kind: 'queued',
      label: t('Compilación programada…', 'Compile scheduled…'),
      detail: s.compileQueued ? '' : t('Se compilará en cuanto dejes de escribir.', 'It will compile as soon as you stop typing.'),
    };
  }

  // The verdict of the last compile. `compileReason` says why it did not end
  // with a new PDF on screen; it is shown whatever the verdict.
  const reason = String(s.compileReason || '').trim();
  const first = errorSummary(list);
  const join = (...parts) => parts.filter(Boolean).join(' · ');

  // 5. No PDF.
  if (s.lastCompileOk === false) {
    return { kind: 'error', label: t('Error de compilación', 'Compilation error'), detail: join(first, reason) };
  }
  // 6. A PDF, but LaTeX recovered from errors on the way. Amber, not red: red
  //    said "nothing came out" and sent people pressing compile again for a
  //    PDF that was already there.
  if (s.lastCompileOk === 'warn') {
    return {
      kind: 'warn',
      label: t('Compilado con errores', 'Compiled with errors'),
      detail: join(first || t('El PDF se ha generado, pero LaTeX ha encontrado errores. Míralos en Problemas.',
        'The PDF was built, but LaTeX reported errors. See Problems.'), reason),
    };
  }
  // 7. Fine.
  if (s.lastCompileOk === true) {
    return {
      kind: 'ok',
      label: t('Compilado', 'Compiled') + (s.compileMs > 0 ? ` · ${secs(s.compileMs)} s` : ''),
      detail: reason,
    };
  }
  // No verdict, yet there is a reason (a compile that was stopped, say): that
  // is worth an amber dot — there is something to read.
  if (reason) return { kind: 'warn', label: t('Sin PDF nuevo', 'No new PDF'), detail: reason };
  // 8. Nothing has been compiled in this session.
  return { kind: 'idle', label: t('Sin compilar', 'Not compiled yet'), detail: '' };
}

// One memo for the whole app, outside any component: the LED mounts and
// unmounts with zen mode, the status bar is hidden by it, and neither should
// own the computation.
export const compileStatus = createRoot(() => createMemo(
  () => deriveCompileStatus(state, problems()),
  undefined,
  { equals: (a, b) => a.kind === b.kind && a.label === b.label && a.detail === b.detail },
));
