// The kernel namespace ledger.
//
// The kernel's namespace is the accumulated effect of the cell bodies it has
// executed, in order, since its last reset. This keeps that exact list.
//
// WHY IT EXISTS. "Run every cell" — which is also what every background
// compile does — used to reset the interpreter and re-run the whole document.
// On a report whose first cell reads a dataset and whose second runs a
// thirty-second simulation, editing a paragraph of prose meant waiting thirty
// seconds for a PDF that could not possibly have changed.
//
// WHY IT IS SAFE. A prefix may be skipped ONLY when the ledger is exactly a
// prefix of what we are about to run: those cells have already been executed,
// in the same order, against this very namespace. Any divergence at any
// position, a different working directory, or a namespace whose contents we
// cannot describe (a failed cell, an interrupt, a crashed kernel) drops back to
// a full reset. Skipping can therefore never produce a value that a full run
// would not have produced.

// WHAT A CELL READ. Code is not all a cell depends on: `pd.read_excel(...)`
// returns different numbers the moment the spreadsheet changes, with the same
// code. The kernel reports the files each cell opened for reading, with their
// {mtime, size}; `reads(n)` hands back those of the first n cells so the caller
// can check them against the disk before trusting the prefix.

export function createLedger() {
  let chain = [];
  let deps = []; // per chain entry: [[path, mtime, size], ...]
  let cwd;
  let known = true; // false = the namespace contents are unknown

  return {
    /** The kernel was reset: the namespace is empty, and we know it exactly. */
    reset(dir) {
      chain = [];
      deps = [];
      cwd = dir;
      known = true;
    },

    /** The namespace changed in a way we cannot describe. */
    invalidate() {
      chain = [];
      deps = [];
      known = false;
    },

    /** Record a cell body that ran successfully against the current namespace,
     *  and the data files it read. */
    record(hash, dir, reads) {
      if (!known) return;
      if (cwd !== undefined && dir !== undefined && dir !== cwd) {
        chain = [];
        deps = [];
        known = false;
        return;
      }
      if (dir !== undefined) cwd = dir;
      chain.push(hash);
      deps.push(Array.isArray(reads) ? reads : []);
    },

    /** The files the first `n` recorded cells read: [{path, mtime, size}]. */
    reads(n) {
      const out = [];
      for (const list of deps.slice(0, n)) {
        for (const r of list) {
          if (Array.isArray(r) && typeof r[0] === 'string') out.push({ path: r[0], mtime: r[1], size: r[2] });
        }
      }
      return out;
    },

    /** How many leading cells of `hashes` the kernel has already executed. */
    prefix(hashes, dir) {
      if (!known) return 0;
      if (cwd !== undefined && dir !== undefined && dir !== cwd) return 0;
      if (chain.length > hashes.length) return 0;
      for (let i = 0; i < chain.length; i++) if (chain[i] !== hashes[i]) return 0;
      return chain.length;
    },

    /** Introspection, for tests and diagnostics. */
    state() {
      return { chain: [...chain], cwd, known };
    },
  };
}
