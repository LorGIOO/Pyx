// Bridge between the editor cells and the persistent Python kernel.
import { state } from '../core/state.js';
import {
  kernelExec, kernelStart, kernelReset, kernelSetPython, kernelInterrupt, isTauri,
} from '../core/platform.js';
import { general, setGeneral } from '../solid/stores/settingsStore.js';
import { createLedger } from './ns-ledger.js';

let reqId = 1;
let started = false;

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
    started = true;
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
    started = true;
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
    started = false;
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
    const res = await kernelExec({ id: reqId++, code, cwd, reset: !!reset });
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
  // on every keystroke, nor mark the kernel busy.
  if (!silent) state.kernelStatus = 'busy';
  try {
    const res = await kernelExec({ id: reqId++, evals: exprs, cwd });
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
    started = false;
    nsInvalidate();
  }
  return withKernelLock(async () => {
    state.kernelStatus = 'starting';
    try {
      await kernelReset();
      started = true;
      nsReset(undefined);
      state.kernelStatus = 'ready';
    } catch (e) {
      nsInvalidate();
      state.kernelStatus = 'error';
    }
  });
}
