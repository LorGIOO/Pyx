// Bridge between the editor cells and the persistent Python kernel.
import { state } from '../core/state.js';
import {
  kernelExec, kernelStart, kernelReset, kernelSetPython, kernelInterrupt, isTauri,
} from '../core/platform.js';
import { general, setGeneral } from '../solid/stores/settingsStore.js';
import { createExecState } from './exec-state.js';
import { analyzePython } from './py-deps.js';
import { cellKey } from './cell-parse.js';
import { setStarNames, clearStarNames, unknownStarModules } from './dep-plan.js';
import { notebookCodeHash, notebookDefs, linkInfo } from './notebooks.js';
import { hashString } from '../core/hash.js';
import { dirOf } from '../core/paths.js';

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

/* ---------------- what the namespace holds (incremental execution) ----------------
   Which version of each cell the kernel's namespace reflects, and what it
   defined: the dependency graph (dep-plan.js) re-runs only the cells a change
   reaches, and early cutoff skips those whose inputs came out equal. See
   exec-state.js for the bookkeeping and why an unknown namespace is never
   reused. */
const ns = createExecState();

/** The kernel was just reset: the namespace is empty and we know it exactly. */
export const nsReset = (cwd) => ns.reset(cwd);
/** The namespace changed in a way we cannot describe (crash, restart). */
export const nsInvalidate = () => ns.invalidate();
/** A cell ran to completion: `D` is what it defines (the plan's effects). */
export const nsRecord = (key, hash, cwd, reads, D) => ns.record(key, hash, cwd, reads, D);
/** A cell failed or was interrupted. */
export const nsFail = (key, D) => ns.fail(key, D);
/** These cells' results were computed from inputs that have since changed. */
export const nsMarkStale = (keys) => ns.markStale(keys);
export const nsIsStale = (key) => ns.isStale(key);
/** The data files the given cells read, to check against the disk. */
export const nsReads = (keys) => ns.reads(keys);
/** Names bound to immutable values, as the kernel last reported them. */
export const nsImmutable = () => ns.state().immutable;
/** What to run for a program ([{key, hash, info}]). */
export const nsPlan = (program, opts) => ns.plan(program, opts);

/** The key a cell's run is filed under: unique across a project's files. */
export const execKey = (path, docId, cell) => `${path || `doc:${docId}`}::${cellKey(cell)}`;
/** A planner program from [{key, cell, info?}] (`info`: an entry that is not
 *  code, such as a linked notebook's values, says what it defines). */
export const programOf = (entries) => entries.map(({ key, cell, info }) => ({
  key, hash: cell.codeHash, info: info || analyzePython(cell.code),
}));

/* ---------------- linked notebooks: their values, not their code ----------------
   See kernel.py `_nb_fetch`. For each \pynotebook the document takes the
   variables it uses from the notebook's live Jupyter kernel, or from the
   snapshot of the last ones (valid while the notebook's code — and, for a
   snapshot of Pyx's own run, its data files — are the same). Only when
   neither exists do the notebook's cells run here, and then the snapshot is
   taken from that run, so they do not run again next time. */
export async function notebookLink(op, payload) {
  if (!isTauri()) return { source: null, reason: 'requiere la app de escritorio' };
  await ensureKernel();
  return kernelExec({ id: reqId++, nblink: op, ...payload });
}

/** Every one of these entries ran in this namespace, with this exact code. */
export function nsHasRun(entries) {
  if (!entries.length) return false;
  const { ran, known } = ns.state();
  if (!known) return false;
  return entries.every((e) => {
    const r = ran.get(e.key);
    return !!r && r.hash === e.cell.codeHash && !r.stale;
  });
}

/**
 * How a linked notebook takes part in a run.
 * @param {string} nbPath
 * @param {object[]} cells   its code cells (notebooks.js loadNotebook)
 * @param {Set<string>|null} needed  names the document reads (null: unknown)
 * @param {string} cwd
 * @param {{fresh?: boolean, own?: Set<string>}} [opts]
 *   fresh — the namespace is about to be emptied (what ran here does not count);
 *   own — names the document defines itself (never reported as missing).
 * @returns {Promise<{mode:'link'|'run'|'none', entries:object[], names?:string[],
 *   extras?:string[], codeHash:string, source?:string, from?:string, label?:string,
 *   when?:number, missing?:string[], errors?:object, ms?:number, reason?:string,
 *   ranHere?:boolean}>}
 *   link — one entry that puts the values in the namespace; run — its cells;
 *   none — the document uses none of its variables (nothing runs).
 *
 * Where the values come from, best first: the notebook's LIVE Jupyter kernel
 * (what the user sees there); what already ran in this session; the snapshot
 * of the last values while the code is the same; and only when there is none
 * of these, its cells run here — once: their values are then saved.
 */
export async function resolveNotebook(nbPath, cells, needed, cwd, { fresh = false, own = null } = {}) {
  const entries = cells.map((cell) => ({ key: execKey(nbPath, null, cell), cell, notebook: true }));
  const codeHash = notebookCodeHash(cells);
  const defs = notebookDefs(cells);
  let names = null;
  if (needed) names = [...needed].filter((n) => !defs || defs.has(n)).sort();
  else if (defs) names = [...defs].sort();
  // The notebook's other values: kept in its snapshot when they are small, so
  // a \py{} added later is served too, with Jupyter closed.
  const extras = defs && names ? [...defs].filter((n) => !names.includes(n)).sort() : [];
  const ranHere = !fresh && nsHasRun(entries);
  const base = { entries, codeHash, names, asked: names, extras, ranHere };
  if (!names) return { mode: 'run', ...base, reason: 'no se puede saber qué variables usa el documento' };
  if (!names.length) return { mode: 'none', ...base, entries: [] };
  const t0 = performance.now();
  let r = null;
  try {
    r = await notebookLink('fetch', {
      notebook: nbPath, names, extra: extras, codeHash, required: defs ? names : [], cwd,
    });
  } catch (e) {
    r = { source: null, reason: String((e && e.message) || e) };
  }
  const ms = performance.now() - t0;
  if (!r || !r.source) {
    return { mode: 'run', ...base, ms, reason: ranHere ? 'ya ejecutado en esta sesión' : (r && (r.reason || r.error)) || '' };
  }
  // Its cells already ran here and Jupyter has nothing newer to offer: the
  // namespace holds their values already, nothing to load.
  if (ranHere && r.source !== 'jupyter') return { mode: 'run', ...base, ms, reason: 'ya ejecutado en esta sesión' };
  const got = r.names || {};
  const avail = names.filter((n) => Object.prototype.hasOwnProperty.call(got, n));
  const token = hashString(avail.map((n) => `${n}:${got[n]}`).join('|'));
  const modules = new Map();
  for (const n of avail) if (String(got[n]).startsWith('module:')) modules.set(n, String(got[n]).slice(7));
  const cell = {
    code: '', codeHash: token, id: 'valores', index: 0, nth: 0, headerLn: 0, notebook: nbPath, dir: dirOf(nbPath),
  };
  return {
    mode: 'link',
    ...base,
    entries: [{ key: execKey(nbPath, null, cell), cell, notebook: true, link: { names: avail }, info: linkInfo(avail, modules) }],
    names: avail, source: r.source, from: r.from, label: r.label, when: r.when,
    missing: (r.missing || []).filter((n) => names.includes(n) && !(own && own.has(n))),
    errors: r.errors || {}, ms,
  };
}

/** One line for the log: where a linked notebook's values came from. */
export function notebookNote(nbPath, plan, ran) {
  const name = String(nbPath).split(/[\\/]/).pop();
  if (!plan) return '';
  if (plan.mode === 'none') return `${name}: el documento no usa ninguna de sus variables (no se ha ejecutado)`;
  if (plan.mode === 'link') {
    const n = plan.names.length;
    const what = `${n} variable${n === 1 ? '' : 's'}`;
    const t = plan.ms != null ? ` en ${Math.round(plan.ms)} ms` : '';
    if (plan.source === 'jupyter') return `${name}: ${what} tomadas de Jupyter (${plan.label || 'kernel abierto'})${t}, sin ejecutar el cuaderno`;
    const when = plan.when ? ` del ${new Date(plan.when * 1000).toLocaleString()}` : '';
    const of = plan.from === 'jupyter' ? `de Jupyter${when}` : `de la última ejecución en Pyx${when}`;
    return `${name}: ${what} guardadas (${of})${t}, sin ejecutar el cuaderno`;
  }
  if (!ran) return `${name}: ya cargado en esta sesión, sin ejecutar nada`;
  const why = plan.reason ? ` (${plan.reason})` : '';
  return `${name}: ejecutado en Pyx${why}; sus valores quedan guardados y no se volverá a ejecutar mientras su código no cambie`;
}

/** Run the entry that stands for a notebook's values: put them in the
 *  namespace (fresh objects) and record it like any cell. */
export async function runLinkEntry(entry, cwd, meta = {}) {
  const key = meta.key || entry.key;
  let res;
  try {
    res = await notebookLink('apply', { notebook: entry.cell.notebook, names: entry.link.names, cwd });
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) };
  }
  if (res && res.ok) {
    nsRecord(key, entry.cell.codeHash, cwd, [], meta.D);
    const bad = Object.entries(res.errors || {});
    return {
      ok: true,
      unchanged: res.unchanged || [],
      stderr: bad.length ? `No se pudieron cargar del cuaderno: ${bad.map(([n, e]) => `${n} (${e})`).join('; ')}` : '',
      loadErrors: res.errors || {},
    };
  }
  nsFail(key, meta.D);
  const msg = (res && res.error) || 'sin respuesta del kernel';
  return { ok: false, stdout: '', stderr: msg, error: { type: 'Error', msg: `no se pudieron cargar los valores del cuaderno: ${msg}` } };
}

/** After the notebook's cells ran here: keep their values as its snapshot,
 *  so they are not run again (plan: what resolveNotebook returned). */
export async function saveNotebookValues(nbPath, plan, cwd) {
  if (!plan || !plan.names || !plan.names.length) return null;
  const reads = nsReads(plan.entries.map((e) => e.key)).map((r) => [r.path, r.mtime, r.size]);
  try {
    return await notebookLink('save', {
      notebook: nbPath, names: plan.names, extra: plan.extras || [], codeHash: plan.codeHash, reads, cwd,
    });
  } catch (_) {
    return null;
  }
}

/** Delete names from the namespace (a removed cell's, before its readers re-run). */
export async function forgetNames(names) {
  if (!isTauri() || !names.length) return;
  await kernelExec({ id: reqId++, forget: names });
}

/** Ask the kernel what `from X import *` binds for the modules a program
 *  star-imports and the planner does not know yet (dep-plan.js). Call it
 *  holding the kernel lock, before planning. Never fails: a module it cannot
 *  answer for just keeps its cells as unanalyzable. */
export async function ensureStarNames(program, cwd) {
  if (!isTauri()) return;
  const mods = unknownStarModules(program.map((p) => p.info));
  if (!mods.length) return;
  try {
    await ensureKernel();
    const r = await kernelExec({ id: reqId++, starnames: mods, cwd });
    for (const [mod, names] of Object.entries((r && r.starnames) || {})) setStarNames(mod, names);
  } catch (_) { /* the planner falls back to the exact rule */ }
}

/** The interpreter process changed: what it had imported, and what modules
 *  export (a library may have been upgraded), is no longer known. */
function forgetProcess() {
  warmed.clear();
  missing.clear();
  state.missingModules = [];
  clearStarNames();
}

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
    started = true; forgetProcess();
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
    started = true; forgetProcess();
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
    started = false; forgetProcess();
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
 * @param {{cwd?: string, reset?: boolean, watch?: string[]}} opts  `watch`: names
 *   whose value the response should say came out unchanged (early cutoff)
 */
export async function runCellCode(code, { cwd, reset, watch } = {}) {
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
    let res = await kernelExec({ id: reqId++, code, cwd, reset: !!reset, watch: watch || [] });
    if (reset && res && Array.isArray(res.restart) && res.restart.length) {
      // The document modified a library in the running process
      // (`scipy.constants.g = 10`, `math.pi = …`): no in-process reset can
      // undo that, so the kernel asked for a new process. Replacing it here,
      // inside the caller's sequence, keeps the compile's promise — every
      // result comes from the document as it is now.
      await kernelReset();
      started = true; forgetProcess();
      lastRestart = res.restart;
      if (code && code.trim()) res = await kernelExec({ id: reqId++, code, cwd, watch: watch || [] });
      else res = { ...res, restarted: true };
    }
    if (reset) nsReset(cwd);
    if (res && Array.isArray(res.immutable)) ns.setImmutable(res.immutable);
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
/* ---------------- completion and signatures (jedi) ----------------
   Read-only questions about the live namespace. They never start a kernel,
   never wait behind a running cell (the answer would come too late to be of
   any use) and never flip the status indicator. null = no answer: the editor
   falls back to what it knows statically. */
function kernelIdle() {
  return isTauri() && started && state.kernelStatus === 'ready' && !kernelSequenceActive();
}
export async function kernelComplete(code, line, col, cwd) {
  if (!kernelIdle()) return null;
  try {
    const r = await kernelExec({ id: reqId++, complete: code, line, col, cwd });
    return r && Array.isArray(r.items) ? r : null;
  } catch (_) {
    return null;
  }
}
export async function kernelInspect(code, line, col, cwd) {
  if (!kernelIdle()) return null;
  try {
    const r = await kernelExec({ id: reqId++, inspect: code, line, col, cwd });
    return r && r.inspect && (r.inspect.signature || r.inspect.doc) ? r.inspect : null;
  } catch (_) {
    return null;
  }
}

// Top-level modules a document imports that the interpreter does not have
// (the status bar offers to install them). Forgotten when the process changes.
const missing = new Set();
export const missingModules = () => [...missing];

/** Run a user macro in the kernel (its own namespace). */
export async function kernelMacro(code, { selection, document, line, cwd } = {}) {
  if (!isTauri()) return { error: 'Las macros necesitan la app de escritorio.' };
  await ensureKernel();
  return withKernelLock(() => kernelExec({ id: reqId++, macro: code, selection, document, line, cwd }));
}

export async function prewarmModules(names, cwd) {
  if (!isTauri()) return;
  const todo = [...new Set(names)].filter((n) => n && !warmed.has(n));
  if (!todo.length) return;
  todo.forEach((n) => warmed.add(n));
  try {
    await ensureKernel();
    // Under the lock: a compile that starts meanwhile simply waits, and finds
    // the imports done.
    const r = await withKernelLock(() => kernelExec({ id: reqId++, prewarm: todo, cwd }));
    const res = (r && r.prewarm) || {};
    for (const [mod, v] of Object.entries(res)) {
      const top = mod.split('.')[0];
      if (v === 'no instalado en Python') missing.add(top); else if (v === true) missing.delete(top);
    }
    state.missingModules = [...missing];
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
    started = false; forgetProcess();
    nsInvalidate();
  }
  return withKernelLock(async () => {
    state.kernelStatus = 'starting';
    try {
      await kernelReset();
      started = true; forgetProcess();
      nsReset(undefined);
      state.kernelStatus = 'ready';
    } catch (e) {
      nsInvalidate();
      state.kernelStatus = 'error';
    }
  });
}
