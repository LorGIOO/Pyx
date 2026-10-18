// Which cells must run — the dependency graph (marimo's idea, made strict).
//
// The kernel's namespace is the result of running the document's cells. When
// one cell changes, a notebook either re-runs everything below it (what Pyx
// did) or only what depends on it (what marimo does). The second is what
// makes a heavy calculation report feel instant: editing the plot at the end
// no longer re-runs the thirty-second simulation above it.
//
// From what each cell defines (D) and reads (U) — py-deps.js plus what the
// kernel knows about values — the plan is the smallest set S of cells such
// that running S, in document order, leaves the namespace exactly as a full
// run would. Closure rules, for every cell i in S:
//
//   R1  a later cell that reads something i defines          → in S
//   R2  a later cell that also defines something i defines   → in S
//       (otherwise i's value would replace the later one)
//   R3  i reads n, and n is (re)defined at or after i — the namespace holds
//       that later value, not the one i must see. So the last cell defining n
//       BEFORE i joins S (and, by R2, every later definer after it). With no
//       earlier definer, n is deleted before running.
//
// Seeds: changed cells, new cells, cells marked stale, and the cells touching
// names a removed or edited cell no longer defines (those names are deleted
// first, so a reader left behind fails exactly as it would in a full run).
//
// Mutation counts as definition: `lst.append(1)` defines `lst`, so editing a
// cell that appends re-runs the cell that created the list first — otherwise
// the list would grow twice. Whether a call mutates is decided here, with
// what py-deps cannot know: which names are modules, which values are
// immutable (the kernel reports them), which methods never modify.
//
// One `opaque` cell (exec, `global`, IPython magics, star imports…) and the
// planner gives up on the graph and uses the old exact rule instead: run from
// the first cell that differs from what the kernel executed, or everything.

/* ---------------- what calls do ---------------- */

const BUILTINS = new Set(`abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr
classmethod compile complex copyright credits delattr dict dir divmod enumerate filter float format
frozenset getattr hasattr hash help hex id input int isinstance issubclass iter len list map max
memoryview min next object oct open ord pow print property range repr reversed round set setattr
slice sorted staticmethod str sum super tuple type zip display __build_class__ Exception ValueError
TypeError KeyError IndexError RuntimeError ZeroDivisionError ArithmeticError AssertionError
AttributeError NameError NotImplementedError OSError StopIteration Warning UserWarning`.split(/\s+/));
// Builtins that change their first argument.
const MUT_BUILTINS = new Set(['next', 'setattr', 'delattr']);

// Libraries whose functions do not modify their arguments (save the few
// listed below). A package that is not here — the project's own modules
// above all — is assumed to modify whatever it is given.
const PURE_LIBS = new Set(`numpy scipy pandas sympy math cmath statistics decimal fractions datetime
time matplotlib seaborn plotly bokeh altair pint handcalcs forallpeople uncertainties numba re json
csv itertools functools operator collections string textwrap os pathlib shutil glob io sys copy
random secrets hashlib base64 struct enum dataclasses typing warnings pprint tabulate IPython
openpyxl xlrd sklearn statsmodels networkx shapely mpmath control sectionproperties pyx
latexify efficalc`.split(/\s+/));
const LIB_MUTATORS = new Set(['shuffle', 'copyto', 'put', 'place', 'putmask', 'fill_diagonal',
  'heapify', 'heappush', 'heappop', 'heapreplace', 'heappushpop', 'insort', 'insort_left', 'insort_right']);

// Methods that never modify the object they are called on. Anything else on
// a mutable value counts as a modification.
const PURE_METHODS = new Set(`copy mean sum std var min max argmin argmax argsort cumsum cumprod prod
round astype reshape flatten ravel transpose dot tolist item any all nonzero conj conjugate trace
diagonal clip squeeze swapaxes view searchsorted sort_values sort_index head tail describe info
to_numpy to_list to_dict to_string to_latex to_markdown to_csv to_excel to_html to_json to_records
groupby agg aggregate apply map applymap merge join pivot pivot_table melt query filter drop dropna
fillna rename reset_index set_index replace assign isna isnull notna notnull unique nunique
value_counts count idxmax idxmin quantile median mode abs diff pct_change rolling expanding resample
shift iterrows itertuples items keys values get format upper lower title capitalize strip lstrip
rstrip split rsplit splitlines startswith endswith find rfind index rindex zfill center ljust rjust
encode decode isdigit isalpha isnumeric isalnum isspace partition rpartition casefold expandtabs
format_map translate hex is_integer as_integer_ratio bit_length union intersection difference
symmetric_difference issubset issuperset isdisjoint subs evalf n simplify expand factor integrate
limit series doit rewrite coeff collect cancel apart together trigsimp inv det eigenvals eigenvects
norm rank rref LUsolve solve to to_base_units m_as to_compact to_reduced_units strftime isoformat date
timestamp weekday isoweekday corr cov nlargest nsmallest between isin where mask interpolate
cummax cummin explode stack unstack crosstab sample select_dtypes memory_usage equals compare
get_xlim get_ylim get_figure get_legend_handles_labels`.split(/\s+/));

const randomish = (mod, path) => /(^|\.)random(\.|$)/.test(mod || '') || (path || []).includes('random');
const topPackage = (mod) => String(mod || '').replace(/^\.+/, '').split('.')[0];

/**
 * The program-wide facts that decide what a call does.
 * @param {import('./py-deps.js').CellInfo[]} infos
 * @param {Iterable<string>} immutable names whose current value is immutable (from the kernel)
 */
export function buildContext(infos, immutable = []) {
  const imports = new Map();
  const assigned = new Set();
  const fns = new Map();
  for (const info of infos) {
    for (const [name, mod] of info.imports) imports.set(name, mod);
    for (const d of info.defs) if (!info.imports.has(d)) assigned.add(d);
    for (const [name, rec] of info.fns) {
      const prev = fns.get(name);
      fns.set(name, prev ? { muts: prev.muts.concat(rec.muts), refs: new Set([...prev.refs, ...rec.refs]) } : rec);
    }
  }
  // A name both imported and assigned somewhere is not reliably a module.
  for (const n of assigned) imports.delete(n);
  return { imports, assigned, fns, immutable: new Set(immutable), effects: new Map() };
}

/** Names a list of mutation records modifies, and whether the RNG is touched. */
function resolveMuts(muts, ctx, mutated, rng) {
  const isLib = (n) => ctx.imports.has(n);
  const knownLib = (n) => PURE_LIBS.has(topPackage(ctx.imports.get(n)));
  for (const m of muts) {
    switch (m.kind) {
      case 'strong': case 'out':
        mutated(m.root, true);
        break;
      case 'method':
        if (isLib(m.root)) {
          if (randomish(ctx.imports.get(m.root), m.path)) rng();
          if (!knownLib(m.root)) mutated(m.root, false); // the project's own module keeps state
        } else if (m.temp) {
          if (m.inplace) mutated(m.root, false);
        } else if (m.inplace || !PURE_METHODS.has(m.method)) {
          mutated(m.root, false);
        }
        break;
      case 'arg': {
        if (isLib(m.root)) break; // a module handed to a function
        const c = m.callee;
        if (c.kind === 'name') {
          if (ctx.assigned.has(c.root)) mutated(m.root, false);         // the document's own function
          else if (isLib(c.root)) {
            if (randomish(ctx.imports.get(c.root), [])) rng();
            if (!knownLib(c.root) || LIB_MUTATORS.has(c.name)) mutated(m.root, false);
          } else if (BUILTINS.has(c.root)) {
            if (MUT_BUILTINS.has(c.root)) mutated(m.root, false);
          }
          // A name nothing defines can only raise NameError: no effect.
        } else if (c.kind === 'member') {
          if (isLib(c.root)) {
            if (randomish(ctx.imports.get(c.root), c.path)) rng();
            if (!knownLib(c.root) || LIB_MUTATORS.has(c.name)) mutated(m.root, false);
          }
          // An object's method: the receiver rule (above) covers the object.
        } else mutated(m.root, false);
        break;
      }
      default:
    }
  }
}

/** What calling the document's function `name` may modify (transitively). */
function fnEffects(name, ctx, seen = new Set()) {
  if (ctx.effects.has(name)) return ctx.effects.get(name);
  const out = { names: new Set(), rng: false };
  if (seen.has(name)) return out;
  seen.add(name);
  const rec = ctx.fns.get(name);
  if (rec) {
    resolveMuts(rec.muts, ctx, (n, strong) => {
      if (strong || !ctx.immutable.has(n)) out.names.add(n);
    }, () => { out.rng = true; });
    for (const ref of rec.refs) {
      if (ref === name || !ctx.fns.has(ref)) continue;
      const sub = fnEffects(ref, ctx, seen);
      for (const n of sub.names) out.names.add(n);
      if (sub.rng) out.rng = true;
    }
  }
  ctx.effects.set(name, out);
  return out;
}

const RNG = '@rng';

/** A cell's effective definitions and reads, mutations and calls included. */
export function effective(info, ctx) {
  const D = new Set(info.defs);
  const U = new Set(info.reads);
  const mutated = (n, strong) => {
    if (!strong && ctx.immutable.has(n)) return; // an int or a str cannot change in place
    D.add(n);
    U.add(n);
  };
  const rng = () => { D.add(RNG); U.add(RNG); };
  resolveMuts(info.muts, ctx, mutated, rng);
  for (const n of info.reads) {
    if (!ctx.fns.has(n)) continue;
    const eff = fnEffects(n, ctx);
    for (const m of eff.names) { D.add(m); U.add(m); }
    if (eff.rng) rng();
  }
  return { D, U };
}

/* ---------------- the plan ---------------- */

/**
 * @param {object} p
 * @param {{key:string, hash:string, info:import('./py-deps.js').CellInfo}[]} p.program  cells in run order
 * @param {Map<string,{hash:string|null, D:Set<string>, stale?:boolean}>} p.ran  what the namespace holds
 * @param {{key:string, hash:string|null}[]} p.history  cells executed since the reset, in order
 * @param {Iterable<string>} [p.forced]  keys that must run even if unchanged
 * @param {Iterable<string>} [p.immutable]
 * @param {boolean} [p.interactive]  a manual run: seeds are only the forced cells
 * @param {(key:string)=>boolean} [p.owned]  which absent keys count as removed
 *   cells (a single file's run must not delete the other files' names)
 * @returns {{mode:'graph'|'prefix'|'full', run:number[], forget:string[], reason?:string,
 *            effects:{D:Set<string>,U:Set<string>}[]}}
 */
export function planRun({ program, ran, history, forced = [], immutable = [], interactive = false, owned = null }) {
  const n = program.length;
  const opaque = program.find((c) => c.info.opaque);
  const ctx = buildContext(program.map((c) => c.info), immutable);
  const effects = program.map((c) => effective(c.info, ctx));
  const all = () => Array.from({ length: n }, (_, i) => i);
  const forcedSet = new Set(forced);

  if (opaque) {
    // The exact rule: the kernel's history must be precisely the first cells.
    let m = 0;
    while (m < history.length && m < n && history[m].key === program[m].key
      && history[m].hash === program[m].hash) m++;
    const firstForced = program.findIndex((c) => forcedSet.has(c.key));
    if (m !== history.length || (firstForced >= 0 && firstForced < m)) {
      return { mode: 'full', run: all(), forget: [], reason: `celda ${program.indexOf(opaque) + 1}: ${opaque.info.opaque}`, effects };
    }
    return { mode: 'prefix', run: all().slice(m), forget: [], effects };
  }

  const definers = new Map();
  const readers = new Map();
  const push = (map, k, i) => { let a = map.get(k); if (!a) map.set(k, a = []); a.push(i); };
  effects.forEach((e, i) => {
    for (const d of e.D) push(definers, d, i);
    for (const u of e.U) push(readers, u, i);
  });

  const S = new Set();
  // Seeds MUST run. The rest only reached S through what a seed (or another
  // member) defines: at run time each of them runs only if one of those names
  // actually changed value (executePlan's early cutoff).
  const seeds = new Set();
  const queue = [];
  const add = (i, seed = true) => {
    if (seed) seeds.add(i);
    if (!S.has(i)) { S.add(i); queue.push(i); }
  };
  const forget = new Set();
  const dropName = (name) => {
    if (forget.has(name)) return;
    forget.add(name);
    for (const i of definers.get(name) || []) add(i);      // re-create it
    for (const i of readers.get(name) || []) add(i, false); // runs: the name is in `changed`
  };

  const present = new Set(program.map((c) => c.key));
  // A cell that was run and is gone: its names go, and what read them re-runs.
  for (const [key, r] of ran) {
    if (!present.has(key) && (!owned || owned(key)) && r.D) for (const d of r.D) dropName(d);
  }
  program.forEach((c, i) => {
    const r = ran.get(c.key);
    if (forcedSet.has(c.key)) add(i);
    // Compile: every cell whose code is not what the namespace reflects.
    // Interactive (Mayús+Intro): only the cell run and what it reaches, as in
    // marimo — an edited cell elsewhere waits until it is run itself.
    else if (!interactive && (!r || r.hash !== c.hash || r.stale)) add(i);
  });

  while (queue.length) {
    const i = queue.pop();
    const r = ran.get(program[i].key);
    // Names the old version of this cell defined and the new one does not.
    if (r && r.hash !== program[i].hash && r.D) for (const d of r.D) if (!effects[i].D.has(d)) dropName(d);
    for (const d of effects[i].D) {
      for (const j of readers.get(d) || []) if (j > i) add(j, false);   // R1
      for (const j of definers.get(d) || []) if (j > i) add(j, false);  // R2
    }
    for (const u of effects[i].U) {
      const defs = definers.get(u);
      if (!defs) continue;
      if (interactive) {
        // A cell never run that provides an input of this one runs first.
        for (const k of defs) if (k < i && !ran.has(program[k].key)) add(k);
      }
      if (!defs.some((k) => k >= i)) continue;                         // R3
      let prev = -1;
      for (const k of defs) if (k < i && k > prev) prev = k;
      if (prev >= 0) add(prev);
      else {
        forget.add(u);
        for (const k of defs) if (k >= i) add(k);
      }
    }
  }
  forget.delete(RNG);
  return { mode: 'graph', run: [...S].sort((a, b) => a - b), seeds, forget: [...forget], effects };
}

const anyIn = (names, set) => { for (const n of names) if (set.has(n)) return true; return false; };

/**
 * Run a plan, in order, with EARLY CUTOFF: a cell that is in the plan only
 * because of what an earlier cell defines runs only if one of those names
 * really changed value. Re-running `g = 9.81` leaves g equal, so nothing that
 * reads g runs again.
 *
 * @param {{run:number[], seeds?:Set<number>, forget:string[], effects:{D:Set<string>,U:Set<string>}[]}} plan
 * @param {{run:(i:number, watch:string[]) => Promise<{ok:boolean, unchanged?:string[]}>,
 *          forget:(names:string[]) => Promise<void>, stop?:() => boolean}} io
 * @returns {Promise<{ok:boolean, ran:number[], skipped:number[], failedAt?:number, notRun:number[]}>}
 */
export async function executePlan(plan, io) {
  const changed = new Set(plan.forget || []);
  if (plan.forget && plan.forget.length) await io.forget(plan.forget);
  const ran = [];
  const skipped = [];
  const order = plan.run;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    if (io.stop && io.stop()) return { ok: false, ran, skipped, notRun: order.slice(k) };
    const e = plan.effects[i];
    const mustRun = !plan.seeds || plan.seeds.has(i);
    if (!mustRun && !anyIn(e.U, changed) && !anyIn(e.D, changed)) { skipped.push(i); continue; }
    const res = await io.run(i, [...e.D]);
    if (!res || res.ok === false) return { ok: false, ran, skipped, failedAt: i, notRun: order.slice(k + 1) };
    ran.push(i);
    const same = new Set(res.unchanged || []);
    for (const n of e.D) if (!same.has(n)) changed.add(n);
  }
  return { ok: true, ran, skipped, notRun: [] };
}

/**
 * The cells a change would re-run, for the editor's "outdated" marks — the
 * R1/R2 closure of planRun, without the kernel's state: `changed` are the
 * cells whose code differs from what produced their output.
 */
export function downstreamOf(infos, changed, immutable = []) {
  const out = new Set();
  if (!changed.size) return out;
  if (infos.some((i) => i.opaque)) {
    const first = Math.min(...changed);
    infos.forEach((_, i) => { if (i > first && !changed.has(i)) out.add(i); });
    return out;
  }
  const ctx = buildContext(infos, immutable);
  const eff = infos.map((i) => effective(i, ctx));
  const users = new Map(); // name -> cells that read or define it
  eff.forEach((e, i) => {
    for (const n of [...e.U, ...e.D]) { let a = users.get(n); if (!a) users.set(n, a = new Set()); a.add(i); }
  });
  const queue = [...changed];
  const seen = new Set(changed);
  while (queue.length) {
    const i = queue.pop();
    for (const d of eff[i].D) {
      for (const j of users.get(d) || []) {
        if (j > i && !seen.has(j)) { seen.add(j); out.add(j); queue.push(j); }
      }
    }
  }
  return out;
}
