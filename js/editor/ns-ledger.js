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

export function createLedger() {
  let chain = [];
  let cwd;
  let known = true; // false = the namespace contents are unknown

  return {
    /** The kernel was reset: the namespace is empty, and we know it exactly. */
    reset(dir) {
      chain = [];
      cwd = dir;
      known = true;
    },

    /** The namespace changed in a way we cannot describe. */
    invalidate() {
      chain = [];
      known = false;
    },

    /** Record a cell body that ran successfully against the current namespace. */
    record(hash, dir) {
      if (!known) return;
      if (cwd !== undefined && dir !== undefined && dir !== cwd) {
        chain = [];
        known = false;
        return;
      }
      if (dir !== undefined) cwd = dir;
      chain.push(hash);
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
