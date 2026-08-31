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
export function withKernelLock(fn) {
  const run = kernelChain.then(fn, fn);
  // Keep the chain alive even if fn throws.
  kernelChain = run.then(() => {}, () => {});
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
   checking signals). */
let interrupting = false;
let lastInterruptAt = 0;

export async function interruptKernel() {
  if (!isTauri()) return;
  const now = Date.now();
  const hard = now - lastInterruptAt < 4000;
  lastInterruptAt = now;
  interrupting = true;
  try { await kernelInterrupt(hard); } catch (_) { /* best effort */ }
  if (hard) {
    // The process is gone: the next request respawns an empty kernel.
    nsInvalidate();
    state.kernelStatus = 'ready';
  } else {
    // The cell will come back with a KeyboardInterrupt; the namespace kept
    // whatever the cell had already assigned, so it is no longer describable.
    nsInvalidate();
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
  // Through the lock: a manual restart must never land in the MIDDLE of a
  // running sequence (compile / run-all), which would wipe the namespace
  // between the imports and the cells that use them.
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
