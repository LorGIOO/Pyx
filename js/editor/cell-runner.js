// Bridge between the editor cells and the persistent Python kernel.
import { state } from '../core/state.js';
import {
  kernelExec, kernelStart, kernelReset, kernelSetPython, kernelInterrupt, isTauri,
} from '../core/platform.js';
import { general, setGeneral } from '../solid/stores/settingsStore.js';
import { createLedger } from './ns-ledger.js';

let reqId = 1;
let started = false;
// What made the last compile replace the Python process (library objects the
// document modified), for the compile log. Read once, then cleared.
let lastRestart = null;
export function takeRestartReason() {
  const r = lastRestart;
  lastRestart = null;
  return r;
}

// ---- kernel execution lock ----
// The Python kernel serializes individual requests, but two JS-side SEQUENCES
// (e.g. the save-triggered compile, which resets the kernel and re-runs every
// cell, and a manual Shift+Enter on one cell) could interleave their requests:
// the single cell would then run right after the reset and BEFORE the imports,
// failing with NameErrors (plt, np…). Every sequence must hold this lock.
let kernelChain = Promise.resolve();
// How many sequences are running or waiting. `restartKernel` needs to know:
// queueing politely behind a sequence is exactly the wrong thing to do when
// the sequence is the runaway cell you are trying to escape from.
let pending = 0;
export function kernelSequenceActive() { return pending > 0; }
export function withKernelLock(fn) {
  pending++;
  const run = kernelChain.then(fn, fn);
  // Keep the chain alive even if fn throws.
  kernelChain = run.then(() => {}, () => {});
  run.then(() => { pending--; }, () => { pending--; });
  return run;
}

/* ---------------- namespace ledger (incremental execution) ----------------
   Which cell bodies built the kernel's current namespace, in order. See
   ns-ledger.js for why a prefix may be skipped and why that is never wrong. */
const ledger = createLedger();

/** The kernel was just reset: the namespace is empty and we know it exactly. */
export const nsReset = (cwd) => ledger.reset(cwd);
/** The namespace changed in a way we cannot describe (error, crash, restart). */
export const nsInvalidate = () => ledger.invalidate();
/** Record that a cell body ran successfully against the current namespace. */
export const nsRecord = (hash, cwd) => ledger.record(hash, cwd);
/** How many leading cells of `hashes` the kernel has already executed. */
export const nsPrefix = (hashes, cwd) => ledger.prefix(hashes, cwd);

/* ---------------- handcalcs output, whichever way a cell ran ----------------
   A cell may inject LaTeX into the document ONLY when it declares one of the
   handcalcs cell magics on its own line. Anything else (stdout, results,
   figures) stays in the editor.

   The typeset block is cached by the fingerprint of the cell body. A cell the
   compile skips because the ledger says the kernel already ran it still has to
   contribute its block to the build — and the cache is where that block comes
   from. So EVERY run must fill it, not only the compile's own: this used to
   live in the compiler, and a %%render cell run with Shift+Enter or "Ejecutar
   todo" was recorded in the ledger but never cached. The next compile skipped
   the cell, found nothing to put in its place, and dropped the calculation
   from the PDF — compile after compile, until something forced a re-run. */
export const HANDCALCS_MAGIC = /^\s*%%(render|tex)\b/m;
const renderCache = new Map(); // codeHash -> latex | null
const RENDER_CACHE_MAX = 500;
/** Record what a cell produced for the document (null = nothing). */
export function recordRender(hash, code, res) {
  const latex = res && res.render && HANDCALCS_MAGIC.test(code) ? res.render : null;
  if (!renderCache.has(hash) && renderCache.size >= RENDER_CACHE_MAX) {
    renderCache.delete(renderCache.keys().next().value);
  }
  renderCache.set(hash, latex);
}
/** The block a cell body contributes: LaTeX, null (nothing) or undefined (unknown). */
export const cachedRender = (hash) => renderCache.get(hash);
export const renderKnown = (hash) => renderCache.has(hash);

export async function ensureKernel() {
  if (started) return;
  if (!isTauri()) { state.kernelStatus = 'error'; return; }
  state.kernelStatus = 'starting';
  try {
    // Honor the user's chosen interpreter (Python tab) on first start; empty =
    // automatic detection (prefers an interpreter with numpy).
    const path = general.pythonPath;
    const res = path ? await kernelSetPython(path) : await kernelStart();
    if (res && res.python) state.env.python = res.python;
    started = true; warmed.clear();
    nsReset(undefined);
    state.kernelStatus = 'ready';
  } catch (e) {
    state.kernelStatus = 'error';
    nsInvalidate();
    throw e;
  }
}

// Choose the interpreter the kernel runs (path = '' / null → automatic). Persists
// the choice and respawns the kernel with it.
export async function setKernelPython(path) {
  if (!isTauri()) return;
  setGeneral({ pythonPath: path || '' });
  state.kernelStatus = 'starting';
  try {
    const res = await kernelSetPython(path);
    started = true; warmed.clear();
    nsReset(undefined);
    state.kernelStatus = 'ready';
    if (res && res.python) state.env.python = res.python;
  } catch (_) {
    state.kernelStatus = 'error';
    nsInvalidate();
  }
}

/* ---- interrupt ----
   A SOFT interrupt first: the kernel raises KeyboardInterrupt inside the
   running cell, exactly like Jupyter, and the variables you spent minutes
   computing survive. The old behaviour — kill the process — meant stopping a
   runaway loop also threw away the whole session.

   Pressing stop again within a few seconds escalates to the hard kill, for the
   cases a soft interrupt cannot reach (a C extension spinning without ever
   checking signals).

   That escalation used to be invisible: the button said "Interrumpir" before
   and after, so someone whose soft interrupt had not taken had no reason to
   press it a second time rather than conclude the button was broken. Two
   seconds after a soft interrupt that has not landed, `state.kernelForceHint`
   goes true and the button says so. */
let interrupting = false;
let lastInterruptAt = 0;
let hintTimer = 0;

function clearForceHint() {
  if (hintTimer) { clearTimeout(hintTimer); hintTimer = 0; }
  state.kernelForceHint = false;
}

export async function interruptKernel() {
  if (!isTauri()) return;
  const now = Date.now();
  // Once the hint is up, the next press escalates however long the user took
  // to read it — the 4 s window alone gave them two seconds to notice, decide
  // and click.
  const hard = state.kernelForceHint === true || now - lastInterruptAt < 4000;
  lastInterruptAt = now;
  interrupting = true;
  clearForceHint();
  try { await kernelInterrupt(hard); } catch (_) { /* best effort */ }
  if (hard) {
    // The process is gone: the next request respawns an empty kernel.
    started = false; warmed.clear();
    nsInvalidate();
    state.kernelStatus = 'ready';
  } else {
    // The cell will come back with a KeyboardInterrupt; the namespace kept
    // whatever the cell had already assigned, so it is no longer describable.
    nsInvalidate();
    // Still running two seconds on? The signal did not reach the cell. Offer
    // the escalation instead of leaving the user guessing.
    hintTimer = setTimeout(() => {
      hintTimer = 0;
      if (state.kernelStatus === 'busy') state.kernelForceHint = true;
    }, 2000);
  }
}

/**
 * Run a block of Python in the kernel.
 * @param {string} code
 * @param {{cwd?: string, reset?: boolean}} opts
 */
export async function runCellCode(code, { cwd, reset } = {}) {
  if (!isTauri()) {
    return {
      ok: false,
      stdout: '',
      stderr: 'Las celdas Python requieren la app de escritorio (npm run tauri:dev).',
      result: null,
      images: [],
    };
  }
  await ensureKernel();
  state.kernelStatus = 'busy';
  try {
    let res = await kernelExec({ id: reqId++, code, cwd, reset: !!reset });
    if (reset && res && Array.isArray(res.restart) && res.restart.length) {
      // The document modified a library in the running process
      // (`scipy.constants.g = 10`, `math.pi = …`): no in-process reset can
      // undo that, so the kernel asked for a new process. Replacing it here,
      // inside the caller's sequence, keeps the compile's promise — every
      // result comes from the document as it is now.
      await kernelReset();
      started = true; warmed.clear();
      lastRestart = res.restart;
      if (code && code.trim()) res = await kernelExec({ id: reqId++, code, cwd });
      else res = { ...res, restarted: true };
    }
    if (reset) nsReset(cwd);
    state.kernelStatus = res.ok ? 'ready' : 'error';
    return res;
  } catch (e) {
    state.kernelStatus = 'error';
    nsInvalidate();
    // A user interrupt kills the kernel, so the in-flight request fails — show a
    // clear "interrupted" message instead of the generic "terminated" one.
    const msg = interrupting
      ? '⏹ Ejecución interrumpida por el usuario.'
      : String((e && e.message) || e);
    return {
      ok: false,
      stdout: '',
      stderr: msg,
      result: null,
      images: [],
    };
  } finally {
    interrupting = false;
    clearForceHint();
    if (state.kernelStatus === 'busy') state.kernelStatus = 'ready';
  }
}

/**
 * Evaluate a list of \py{...} expressions in the kernel namespace.
 * @returns {Promise<Record<string,{ok:boolean,value:string}>>}
 */
export async function evalExpressions(exprs, { cwd, silent } = {}) {
  if (!isTauri() || !exprs.length) return {};
  await ensureKernel();
  // `silent` (the editor's live ghost values) must not flip the status indicator
  // on every keystroke, nor mark the kernel busy. Nor may it change the
  // namespace: `pure` makes the kernel skip expressions with side effects
  // (\py{lst.pop()}, \py{next(it)}, \py{rng.random()}), which would otherwise
  // run every half second and shift the values the next compile prints.
  if (!silent) state.kernelStatus = 'busy';
  try {
    const res = await kernelExec({ id: reqId++, evals: exprs, cwd, pure: !!silent });
    if (!silent) state.kernelStatus = 'ready';
    return res.evals || {};
  } catch (e) {
    if (!silent) state.kernelStatus = 'error';
    nsInvalidate();
    // Surface the failure on every expression: the compile log then explains
    // each missing value instead of silently substituting with no clue.
    const msg = String((e && e.message) || e);
    const out = {};
    for (const x of exprs) out[x] = { ok: false, value: msg };
    return out;
  }
}

/* ---------------- warm-up ----------------
   Import the libraries a document uses as soon as it is opened, instead of
   inside its first compile (kernel.py `_prewarm`: installed modules only,
   namespace untouched). `warmed` remembers what this kernel process already
   holds, so switching tabs does not ask twice; it is forgotten whenever the
   process is replaced. */
const warmed = new Set();
export async function prewarmModules(names, cwd) {
  if (!isTauri()) return;
  const todo = [...new Set(names)].filter((n) => n && !warmed.has(n));
  if (!todo.length) return;
  todo.forEach((n) => warmed.add(n));
  try {
    await ensureKernel();
    // Under the lock: a compile that starts meanwhile simply waits, and finds
    // the imports done.
    await withKernelLock(() => kernelExec({ id: reqId++, prewarm: todo, cwd }));
  } catch (_) {
    todo.forEach((n) => warmed.delete(n)); // try again next time
  }
}

export async function restartKernel() {
  if (!isTauri()) return;
  // A restart is mostly used for ONE thing: getting out of a cell that is not
  // going to finish. Going through the lock alone made it unable to do that —
  // it queued behind the very sequence it was meant to end, so `while True:`
  // left the button inert for as long as the loop ran.
  //
  // So: if anything holds or is waiting on the lock, kill the process FIRST.
  // The in-flight request then fails at once (interrupt_hard closes the
  // kernel's stdin), its sequence unwinds, the lock frees, and the reset below
  // runs immediately afterwards — still through the lock, so a restart still
  // cannot land between a compile's imports and the cells that use them.
  clearForceHint();
  if (kernelSequenceActive()) {
    interrupting = true;
    lastInterruptAt = Date.now();
    try { await kernelInterrupt(true); } catch (_) { /* best effort */ }
    started = false; warmed.clear();
    nsInvalidate();
  }
  return withKernelLock(async () => {
    state.kernelStatus = 'starting';
    try {
      await kernelReset();
      started = true; warmed.clear();
      nsReset(undefined);
      state.kernelStatus = 'ready';
    } catch (e) {
      nsInvalidate();
      state.kernelStatus = 'error';
    }
  });
}
