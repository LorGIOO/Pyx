// Bridge between the editor cells and the persistent Python kernel.
import { state } from '../core/state.js';
import {
  kernelExec, kernelStart, kernelReset, kernelSetPython, kernelInterrupt, isTauri, fileStamps,
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
/** Let go of the lock whatever holds it. Only for a sequence that is known
 *  never to finish (the compile watchdog abandoned it): the chain is a chain
 *  of promises, and one that never settles would hold every later sequence —
 *  every compile, every Mayús+Intro — behind it for the rest of the session. */
export function releaseKernelLock() {
  kernelChain = Promise.resolve();
  pending = 0;
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
  const q = linkQuery(nbPath, cells, needed, cwd);
  const { entries, names } = q;
  const ranHere = !fresh && nsHasRun(entries);
  const base = { entries, codeHash: q.codeHash, names, asked: names, extras: q.extras, ranHere };
  if (!names) return { mode: 'run', ...base, reason: 'no se puede saber qué variables usa el documento' };
  if (!names.length) return { mode: 'none', ...base, entries: [] };
  const t0 = performance.now();
  const r = await fetchLink(nbPath, q, fresh);
  const ms = performance.now() - t0;
  if (!r || !r.source) {
    if (ranHere) return { mode: 'run', ...base, ms, reason: 'ya ejecutado en esta sesión' };
    const why = (r && (r.reason || r.error)) || '';
    if (fresh) return { mode: 'run', ...base, ms, reason: why };
    // Its code (or a data file) changed and Jupyter is not there: put back
    // everything Pyx's last run of it left, with the cells it came from, so
    // the dependency graph runs ONLY what changed — not the whole notebook.
    //
    // Once per namespace and snapshot: a notebook with a cell that FAILS never
    // gets to "ran here", and every compile used to load its whole snapshot
    // again. What the first restore put back is still there (same epoch) and
    // the ledger knows which cells are pending.
    const meta = Array.isArray(r && r.watch) && r.watch.length ? await stampsOf([r.watch[0]]) : null;
    const memo = restoreMemo.get(nbPath);
    if (memo && meta && ns.known && memo.epoch === ns.epoch && memo.stamp === meta[0]) {
      // (Not `restored`: cells that ran since are not in the snapshot, so the
      // save that follows writes everything, not only this compile's cells.)
      return memo.kept
        ? { mode: 'run', ...base, ms: performance.now() - t0, resumed: true, reason: `${why}; solo se ejecuta lo que falta` }
        : { mode: 'run', ...base, ms, reason: why };
    }
    const restored = await restoreNotebook(nbPath, entries, cwd);
    if (meta) restoreMemo.set(nbPath, { epoch: ns.epoch, stamp: meta[0], kept: restored || 0 });
    if (restored) {
      return { mode: 'run', ...base, ms: performance.now() - t0, restored, reason: `${why}; solo se ejecuta lo que ha cambiado` };
    }
    return { mode: 'run', ...base, ms, reason: why };
  }
  // Its cells already ran here and Jupyter has nothing newer to offer: the
  // namespace holds their values already, nothing to load.
  if (ranHere && r.source !== 'jupyter') return { mode: 'run', ...base, ms, reason: 'ya ejecutado en esta sesión' };
  const got = r.names || {};
  const { avail, token } = linkToken(r, names);
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
    // Taken from Jupyter with other code than the file has now (edited since,
    // not run there): the values may be behind the code — said in the log.
    codeChanged: !!r.codeChanged,
  };
}

/* ---------------- a notebook's answer, remembered ("0 ms") ----------------
   Asking where a notebook's values come from is a round trip to the Python
   kernel, which in turn looks for Jupyter. Its answer names the files and
   folders it depends on (`watch`: the snapshot's meta.json, Jupyter's runtime
   folders, the data files the snapshot read) and says whether it stands while
   none of them changes (`cacheable` — never while a Jupyter kernel serves the
   notebook, is busy or is still starting: those change without touching any
   file). An unchanged notebook is then answered from here: one stat call, no
   kernel request at all.

   The stamps kept with an answer are taken BEFORE asking, or are provably
   older than the question: a change that lands while the kernel answers makes
   the next call ask again — never the other way round. */
const linkCache = new Map(); // notebook path -> { key, r, watch, stamps, sig, live }
const restoreMemo = new Map(); // notebook path -> { epoch, stamp, kept } (resolveNotebook)

async function rawStamps(paths) {
  try {
    const s = await fileStamps(paths);
    return Array.isArray(s) && s.length === paths.length ? s : null;
  } catch (_) {
    return null; // no desktop: nothing is remembered
  }
}
const stampText = (s) => `${s.mtime}:${s.size}`;
async function stampsOf(paths) {
  const s = await rawStamps(paths);
  return s ? s.map(stampText) : null;
}
const sameList = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/** What a document asks a notebook for, and the cells it would run. */
function linkQuery(nbPath, cells, needed, cwd) {
  const entries = cells.map((cell) => ({ key: execKey(nbPath, null, cell), cell, notebook: true }));
  const codeHash = notebookCodeHash(cells);
  const defs = notebookDefs(cells);
  let names = null;
  if (needed) names = [...needed].filter((n) => !defs || defs.has(n)).sort();
  else if (defs) names = [...defs].sort();
  // The notebook's other values: kept in its snapshot when they are small, so
  // a \py{} added later is served too, with Jupyter closed.
  const extras = defs && names ? [...defs].filter((n) => !names.includes(n)).sort() : [];
  const required = defs && names ? names : [];
  return {
    entries, codeHash, names, extras, cwd,
    key: names ? [codeHash, names.join(','), extras.join(','), required.length, cwd || ''].join('|') : '',
    payload: () => ({
      notebook: nbPath, names, extra: extras, codeHash, required, cwd,
      // Its code: where a function's definition is found when its kernel
      // cannot give it (kernel.py _from_cells).
      cells: cells.map((c) => c.code),
    }),
  };
}

/** What a notebook's values ARE — the names the document uses and what their
 *  functions need (r.deps): a helper edited in Jupyter loads them again. */
function linkToken(r, names) {
  const got = r.names || {};
  const avail = names.filter((n) => Object.prototype.hasOwnProperty.call(got, n));
  return { avail, token: hashString([...avail, '|', ...(r.deps || [])].map((n) => `${n}:${got[n]}`).join('|')) };
}

/** The kernel's answer for a notebook (kernel.py _nb_fetch) — the remembered
 *  one while nothing it depends on has changed. `fresh` always asks. */
async function fetchLink(nbPath, q, fresh = false) {
  const hit = linkCache.get(nbPath);
  const pre = hit && hit.watch ? await stampsOf(hit.watch) : null;
  if (!fresh && hit && hit.r && hit.key === q.key && pre && sameList(pre, hit.stamps)) return hit.r;
  const asked = Date.now();
  let r = null;
  try {
    r = await notebookLink('fetch', q.payload());
  } catch (e) {
    r = { source: null, reason: String((e && e.message) || e) };
  }
  const watch = r && Array.isArray(r.watch) && r.watch.length ? r.watch : null;
  const entry = {
    key: q.key, r: null, watch, stamps: null,
    sig: r && r.source ? linkToken(r, q.names).token : null,
    live: !!(r && r.source === 'jupyter'),
  };
  if (watch && r.cacheable) {
    if (hit && pre && sameList(hit.watch, watch)) {
      entry.r = r;
      entry.stamps = pre;
    } else {
      // The list is new: these stamps are taken AFTER the answer, so they
      // vouch for it only if nothing was touched around the question (2 s:
      // more than any file system's time resolution).
      const post = await rawStamps(watch);
      if (post && post.every((s) => s.mtime < asked - 2000)) {
        entry.r = r;
        entry.stamps = post.map(stampText);
      }
    }
  }
  linkCache.set(nbPath, entry);
  return r;
}

/** Its remembered answer may no longer hold (a value file is gone, the
 *  interpreter changed): ask again next time. */
function forgetLink(nbPath) {
  if (nbPath === undefined) linkCache.clear();
  else linkCache.delete(nbPath);
}

/** For the watcher (link-watch.js): what the last answer for this notebook
 *  depends on. `sig` — what its values were (null: it had none to give);
 *  `live` — they came from a running Jupyter kernel, which no file reflects. */
export function linkWatchInfo(nbPath) {
  const e = linkCache.get(nbPath);
  if (!e) return { known: false, watch: [], stamps: null, sig: null, live: false, cached: false };
  return { known: true, watch: e.watch || [], stamps: e.r ? e.stamps : null, sig: e.sig, live: e.live, cached: !!e.r };
}

/** Ask for a notebook's values AHEAD of the compile that will use them, with
 *  the kernel free: Jupyter copies what changed to disk now, and the answer is
 *  remembered. Nothing enters the namespace and the run ledger is untouched —
 *  the compile still decides what to load and which cells read it. Never
 *  starts a kernel and never queues behind a running cell or compile.
 *  @returns {Promise<{sig: string|null, live: boolean}|null>} null: not asked */
export function preloadNotebook(nbPath, cells, needed, cwd) {
  if (!kernelIdle()) return Promise.resolve(null);
  const q = linkQuery(nbPath, cells, needed, cwd);
  if (!q.names || !q.names.length) return Promise.resolve(null);
  return withKernelLock(async () => {
    if (!started || state.kernelStatus !== 'ready') return null;
    const r = await fetchLink(nbPath, q);
    return { sig: r && r.source ? linkToken(r, q.names).token : null, live: !!(r && r.source === 'jupyter') };
  });
}

/* What went wrong around a notebook without stopping anything: it used to be
   swallowed (`catch (_)`), and the only sign was a notebook that ran again or
   a value that was not the expected one. The compile lists them in its log. */
const linkProblems = [];
function noteLinkProblem(msg) {
  if (linkProblems.length < 20 && !linkProblems.includes(msg)) linkProblems.push(msg);
}
export function takeLinkProblems() { return linkProblems.splice(0); }
const errText = (e) => String((e && e.message) || e);
const nbName = (p) => String(p).split(/[\\/]/).pop();

const kindOf = (p) => (/\.py$/i.test(String(p)) ? 'archivo' : 'cuaderno');

/** One line for the log: where a linked notebook's values came from. */
export function notebookNote(nbPath, plan, ran) {
  const name = String(nbPath).split(/[\\/]/).pop();
  if (!plan) return '';
  if (plan.mode === 'none') return `${name}: el documento no usa ninguna de sus variables (no se ha ejecutado)`;
  if (plan.mode === 'link') {
    const n = plan.names.length;
    const what = `${n} variable${n === 1 ? '' : 's'}`;
    const t = plan.ms != null ? ` en ${Math.round(plan.ms)} ms` : '';
    // The file was edited after these values were taken and nothing ran in
    // Jupyter since: they may be behind the code. Said, never guessed away.
    const behind = plan.codeChanged
      ? `. Aviso: el ${kindOf(nbPath)} se ha editado después de tomar estos valores y en Jupyter no se ha ejecutado nada desde entonces; si cambiaste celdas, ejecútalas en Jupyter para actualizarlos`
      : '';
    if (plan.source === 'jupyter') return `${name}: ${what} tomadas de Jupyter (${plan.label || 'kernel abierto'})${t}, sin ejecutar el ${kindOf(nbPath)}${behind}`;
    const when = plan.when ? ` del ${new Date(plan.when * 1000).toLocaleString()}` : '';
    const of = plan.from === 'jupyter' ? `de Jupyter${when}` : `de la última ejecución en Pyx${when}`;
    return `${name}: ${what} guardadas (${of})${t}, sin ejecutar el ${kindOf(nbPath)}${behind}`;
  }
  if (plan.restored) {
    return `${name}: ${plan.restored} celda${plan.restored === 1 ? '' : 's'} sin cambios recuperada${plan.restored === 1 ? '' : 's'} de la última ejecución; ${ran ? 'solo se ha ejecutado lo que cambió' : 'no ha hecho falta ejecutar nada'}`;
  }
  if (plan.resumed) {
    return `${name}: lo recuperado de la última ejecución sigue cargado; ${ran ? 'solo se ha ejecutado lo que faltaba' : 'no ha hecho falta ejecutar nada'}`;
  }
  if (!ran) return `${name}: ya cargado en esta sesión, sin ejecutar nada`;
  const why = plan.reason ? ` (${plan.reason})` : '';
  return `${name}: ejecutado en Pyx${why}; sus valores quedan guardados y no se volverá a ejecutar mientras su código no cambie`;
}

/** The notebook's last full run back in the namespace, its cells in the
 *  ledger: returns how many cells need not run again (0/null: nothing to
 *  restore). Only cells still in the notebook with the same code count. */
async function restoreNotebook(nbPath, entries, cwd) {
  if (!ns.known) return null; // the next run starts from a reset anyway
  let r;
  try {
    r = await notebookLink('restore', { notebook: nbPath, cwd });
  } catch (e) {
    noteLinkProblem(`${nbName(nbPath)}: no se pudo recuperar su última ejecución (${errText(e)}); se ejecuta entero`);
    return null;
  }
  if (!r || !r.ok || !Array.isArray(r.ledger)) return null;
  const lost = Object.entries(r.errors || {});
  if (lost.length) {
    noteLinkProblem(`${nbName(nbPath)}: no se pudieron recuperar ${lost.slice(0, 5).map(([n, e]) => `${n} (${e})`).join('; ')}; las celdas que los definen se ejecutan de nuevo`);
  }
  const loaded = new Set(r.loaded || []);
  const current = new Map(entries.map((e) => [e.key, e.cell.codeHash]));
  let kept = 0;
  for (const c of r.ledger) {
    // A cell whose values did not all come back is not "already run".
    if (!current.has(c.key) || !(c.defs || []).every((d) => loaded.has(d))) continue;
    nsRecord(c.key, c.hash, cwd, c.reads || [], new Set(c.defs || []));
    if (current.get(c.key) === c.hash) kept++;
  }
  return kept || null;
}

/** Run the entry that stands for a notebook's values: put them in the
 *  namespace (fresh objects) and record it like any cell. */
export async function runLinkEntry(entry, cwd, meta = {}) {
  const key = meta.key || entry.key;
  let res;
  try {
    res = await notebookLink('apply', { notebook: entry.cell.notebook, names: entry.link.names, key, cwd });
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) };
  }
  if (res && res.ok) {
    nsRecord(key, entry.cell.codeHash, cwd, [], meta.D);
    markScope(key); // the apply kept what it gave each name (kernel _SCOPES)
    const bad = Object.entries(res.errors || {});
    // What the functions it took USE and could not be brought along: without
    // this line, calling them ends in a NameError nobody can explain.
    const dep = Object.entries(res.depErrors || {});
    const lines = [];
    if (bad.length) lines.push(`No se pudieron cargar del cuaderno: ${bad.map(([n, e]) => `${n} (${e})`).join('; ')}`);
    if (dep.length) lines.push(`No se pudo traer lo que usan sus funciones: ${dep.map(([n, e]) => `${n} (${e})`).join('; ')}`);
    // A value file may be gone or unreadable: the remembered answer says
    // otherwise, so the next compile asks again.
    if (lines.length) forgetLink(entry.cell.notebook);
    return {
      ok: true,
      unchanged: res.unchanged || [],
      stderr: lines.length ? `${lines.join('. ')}${res.hint ? `. ${res.hint}` : ''}` : '',
      loadErrors: res.errors || {},
    };
  }
  forgetLink(entry.cell.notebook);
  nsFail(key, meta.D);
  const msg = (res && res.error) || 'sin respuesta del kernel';
  return { ok: false, stdout: '', stderr: msg, error: { type: 'Error', msg: `no se pudieron cargar los valores del cuaderno: ${msg}` } };
}

/** After the notebook's cells ran here: keep their values as its snapshot,
 *  so they are not run again (plan: what resolveNotebook returned). */
export async function saveNotebookValues(nbPath, plan, cwd, fresh = null) {
  if (!plan || !plan.entries || !plan.entries.length) return null;
  const reads = nsReads(plan.entries.map((e) => e.key)).map((r) => [r.path, r.mtime, r.size]);
  // A FULL snapshot when the notebook can be followed: every name its cells
  // define, and the ledger of those cells (what each defined and read). After
  // an edit — even in a later session — the kernel puts it all back and only
  // the changed cells run (resolveNotebook → kernel.py _nb_restore).
  const names = new Set(plan.names || []);
  let ledger;
  if (notebookDefs(plan.entries.map((e) => e.cell))) {
    const { ran } = ns.state();
    ledger = [];
    for (const n of plan.extras || []) names.add(n); // all of them, whatever their size
    for (const e of plan.entries) {
      const r = ran.get(e.key);
      if (!r || r.stale || r.hash !== e.cell.codeHash) continue;
      const defs = [...new Set([...analyzePython(e.cell.code).defs, ...(r.D || [])])];
      for (const d of defs) names.add(d);
      ledger.push({ key: e.key, hash: r.hash, defs, reads: r.reads || [] });
    }
  }
  if (!names.size) return null;
  try {
    const res = await notebookLink('save', {
      notebook: nbPath, names: [...names], extra: ledger ? [] : (plan.extras || []), codeHash: plan.codeHash, reads, cwd,
      // What each of its cells gave its names when it ran (captureScope):
      // the file's own values, not what a later file left in their place.
      scopes: plan.entries.map((e) => e.key),
      cells: plan.entries.map((e) => e.cell.code),
      ledger,
      // Only what the cells that ran this time defined is pickled again.
      fresh: fresh ? [...fresh] : undefined,
    });
    if (res && res.error) noteLinkProblem(`${nbName(nbPath)}: no se pudieron guardar sus valores (${res.error})`);
    return res;
  } catch (e) {
    noteLinkProblem(`${nbName(nbPath)}: no se pudieron guardar sus valores (${errText(e)})`);
    return null;
  }
}

/* ---------------- what each cell or file gave a name, where it stands ----------------
   \py{x} between two linked files (or cells) that both define x shows the
   x of the one ABOVE it (compiler.js scopeExpressions). The kernel keeps,
   per entry, the values it gave those names (`_SCOPES`); this remembers
   which entries' copies belong to the run the ledger describes, so an entry
   whose copy is missing — or older than its last run — is run again (a
   linked file's values: just loaded again). */
const scopeMarks = new Map(); // entry key -> the ledger record it was taken from
function markScope(key) {
  const r = ns.state().ran.get(key);
  if (r) scopeMarks.set(key, r);
}
/** Is the kernel's copy of what this entry gave its names current? */
export function scopeCurrent(key) {
  const r = ns.state().ran.get(key);
  return !!r && scopeMarks.get(key) === r;
}
/** Right after a cell ran: keep what it gave these names, for the \py{} below it. */
export async function captureScope(key, names, cwd) {
  if (!isTauri() || !names || !names.length) return;
  try {
    await kernelExec({ id: reqId++, nblink: 'capture', key, names, cwd });
    markScope(key);
  } catch (e) {
    // The \py{} falls back to the final value — which may be another file's.
    noteLinkProblem(`no se pudo conservar el valor de ${names.slice(0, 5).join(', ')} tal como lo dejó su celda (${errText(e)}): un \\py{} que lo lea mostrará el último valor`);
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
    forgetLink(); // another interpreter may not read the same value files
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
  try {
    // Inside the try: a Python that cannot start is this cell's error, shown
    // in it — not an exception that left the cell spinning forever.
    await ensureKernel();
    state.kernelStatus = 'busy';
    // The user's "tiempo máximo por celda", if any (kernel.rs enforces it:
    // a soft interrupt first, a new interpreter if that is ignored).
    const timeout_ms = Math.max(0, +general.cellTimeout || 0) * 1000;
    let res = await kernelExec({ id: reqId++, code, cwd, reset: !!reset, watch: watch || [], timeout_ms });
    if (reset && res && Array.isArray(res.restart) && res.restart.length) {
      // The document modified a library in the running process
      // (`scipy.constants.g = 10`, `math.pi = …`): no in-process reset can
      // undo that, so the kernel asked for a new process. Replacing it here,
      // inside the caller's sequence, keeps the compile's promise — every
      // result comes from the document as it is now.
      await kernelReset();
      started = true; forgetProcess();
      lastRestart = res.restart;
      if (code && code.trim()) res = await kernelExec({ id: reqId++, code, cwd, watch: watch || [], timeout_ms });
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
export async function evalExpressions(exprs, { cwd, silent, scopes } = {}) {
  if (!isTauri() || !exprs.length) return {};
  // `silent` (the editor's live ghost values) must not flip the status indicator
  // on every keystroke, nor mark the kernel busy. Nor may it change the
  // namespace: `pure` makes the kernel skip expressions with side effects
  // (\py{lst.pop()}, \py{next(it)}, \py{rng.random()}), which would otherwise
  // run every half second and shift the values the next compile prints.
  try {
    await ensureKernel();
    if (!silent) state.kernelStatus = 'busy';
    const res = await kernelExec({ id: reqId++, evals: exprs, cwd, pure: !!silent, scopes: scopes || {} });
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
/** The variables a linked notebook or script offers right now ({name: type}):
 *  its live Jupyter kernel's, else its snapshot's — for \py{} completion.
 *  Never waits behind a running cell; cached for a few seconds. */
const linkedCache = new Map(); // path -> { t, names }
export async function linkedNames(nbPath) {
  const hit = linkedCache.get(nbPath);
  if (hit && Date.now() - hit.t < 5000) return hit.names;
  if (!kernelIdle()) return hit ? hit.names : {};
  let names = {};
  try {
    const r = await kernelExec({ id: reqId++, nblink: 'names', notebook: nbPath });
    names = (r && r.names) || {};
  } catch (_) { /* static names only */ }
  linkedCache.set(nbPath, { t: Date.now(), names });
  return names;
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
