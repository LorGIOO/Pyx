// Bridge between the editor cells and the persistent Python kernel.
import { state } from '../core/state.js';
import {
  kernelExec, kernelStart, kernelReset, kernelSetPython, kernelInterrupt, isTauri,
} from '../core/platform.js';
import { general, setGeneral } from '../solid/stores/settingsStore.js';

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
    state.kernelStatus = 'ready';
  } catch (e) {
    state.kernelStatus = 'error';
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
    state.kernelStatus = 'ready';
    if (res && res.python) state.env.python = res.python;
  } catch (_) {
    state.kernelStatus = 'error';
  }
}

// Set while an interrupt is in flight so the failing request reports it as a
// user interrupt rather than an unexpected kernel death.
let interrupting = false;

// Jupyter-style interrupt: stop the running cell. The kernel is killed and the
// next request respawns a fresh one, so the namespace resets (like a restart).
export async function interruptKernel() {
  if (!isTauri()) return;
  interrupting = true;
  try { await kernelInterrupt(); } catch (_) { /* best effort */ }
  state.kernelStatus = 'ready';
}

/**
 * Run a block of Python in the kernel.
 * @param {string} code
 * @param {{cwd?: string, reset?: boolean}} opts
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, result:any, images:string[]}>}
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
    state.kernelStatus = res.ok ? 'ready' : 'error';
    return res;
  } catch (e) {
    state.kernelStatus = 'error';
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
    // Surface the failure on every expression: the compile log then explains
    // each "??" instead of silently substituting with no clue.
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
      state.kernelStatus = 'ready';
    } catch (e) {
      state.kernelStatus = 'error';
    }
  });
}
