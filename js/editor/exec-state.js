// What the kernel's namespace holds — the bookkeeping behind incremental runs.
//
// Two facts are kept, both since the last reset:
//   * `history`: the cells executed, in order (the exact rule: a namespace
//     built by running cells 1…m is reused only for a program that starts with
//     those very cells);
//   * `ran`: for every cell, the version of its code the namespace reflects
//     and what it defined — what the dependency graph (dep-plan.js) needs to
//     re-run only the cells a change reaches.
// Plus the names whose values are immutable, as the kernel last reported
// them: an int handed to a function cannot be modified by it.
//
// Anything we cannot describe — a crashed or replaced kernel, a run in an
// unknown folder — makes the state unknown, and an unknown namespace is never
// reused: the next run starts from a clean one.
//
// WHAT A CELL READ. Code is not all a cell depends on: `pd.read_excel(...)`
// returns different numbers the moment the spreadsheet changes. The kernel
// reports the files each cell opened, with {mtime, size}; the caller checks
// them before trusting a cell it would otherwise skip.

import { planRun } from './dep-plan.js';

export function createExecState() {
  let known = true;
  let cwd;
  let history = [];
  let ran = new Map();
  let immutable = new Set();

  const clear = () => { history = []; ran = new Map(); immutable = new Set(); };

  return {
    /** The kernel was reset: the namespace is empty, and we know it exactly. */
    reset(dir) { clear(); cwd = dir; known = true; },

    /** The namespace changed in a way we cannot describe. */
    invalidate() { clear(); known = false; },

    get known() { return known; },

    /** A cell ran to completion. `D` = what it defines (dep-plan effects). */
    record(key, hash, dir, reads, D) {
      if (!known) return;
      if (cwd !== undefined && dir !== undefined && dir !== cwd) { clear(); known = false; return; }
      if (dir !== undefined) cwd = dir;
      history.push({ key, hash });
      ran.set(key, { hash, D: D || new Set(), reads: Array.isArray(reads) ? reads : [], stale: false });
    },

    /** A cell failed or was interrupted: it left part of its work behind. It
     *  must run again, and the exact rule can no longer trust the history. */
    fail(key, D) {
      if (!known) return;
      history.push({ key, hash: null });
      ran.set(key, { hash: null, D: D || new Set(), reads: [], stale: true });
    },

    /** These cells' results were computed from inputs that have changed. */
    markStale(keys) {
      for (const k of keys) {
        const r = ran.get(k);
        if (r) r.stale = true;
      }
    },

    isStale(key) { const r = ran.get(key); return !!(r && r.stale); },

    /** The kernel's latest list of names bound to immutable values. */
    setImmutable(names) { if (Array.isArray(names)) immutable = new Set(names); },

    /**
     * What to run for `program` ([{key, hash, info}], run order).
     * @returns {{mode:'graph'|'prefix'|'full', run:number[], forget:string[], reason?:string, effects:object[]}}
     */
    plan(program, { dir, forced = [], interactive = false, owned = null } = {}) {
      if (!known || (cwd !== undefined && dir !== undefined && dir !== cwd)) {
        const effects = planRun({ program, ran: new Map(), history: [], immutable: [] }).effects;
        return { mode: 'full', run: program.map((_, i) => i), forget: [], reason: known ? 'otra carpeta' : 'estado desconocido', effects };
      }
      return planRun({ program, ran, history, forced, immutable, interactive, owned });
    },

    /** The data files the given cells read, as [{key, path, mtime, size}]. */
    reads(keys) {
      const out = [];
      for (const key of keys) {
        const r = ran.get(key);
        if (!r) continue;
        for (const f of r.reads) {
          if (Array.isArray(f) && typeof f[0] === 'string') out.push({ key, path: f[0], mtime: f[1], size: f[2] });
        }
      }
      return out;
    },

    /** Introspection, for tests and diagnostics. */
    state() {
      return { known, cwd, history: history.map((h) => ({ ...h })), ran: new Map(ran), immutable: new Set(immutable) };
    },
  };
}
