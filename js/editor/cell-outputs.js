// The cell-output store.
//
// WHY THIS IS ITS OWN MODULE
//
// Outputs used to be a module-level Map keyed by a hash of the cell's CODE.
// That had three consequences, all of them visible to the user:
//
//   * Editing a cell while it ran changed its key, so the result landed under
//     the old key and the output silently vanished.
//   * Two cells with identical code (two empty ones, two `plt.show()`) shared
//     one entry: running either marked both as running and showed one result.
//   * Nothing was ever evicted. Every edit minted a new key and left the old
//     entry — with its base64 PNGs — behind, so a session spent iterating on a
//     figure leaked tens of megabytes.
//
// Outputs are now keyed by `docId:cellKey`, where `cellKey` is the cell's
// STABLE id (the `id=` in its `%#python` marker) and falls back to its ordinal
// for legacy documents that have no ids yet. The store is namespaced per
// document, garbage-collected against the cells that actually exist, and
// serializable so results survive closing and reopening a `.pltx`.

import { hashString } from '../core/hash.js';

/** docId -> Map(cellKey -> output) */
const byDoc = new Map();

/** Total base64 payload we keep in memory across all documents. Beyond this,
 *  the oldest results shed their images (the text output is kept — it is what
 *  a calculation report usually needs). */
const IMAGE_BUDGET = 64 * 1024 * 1024;

function docMap(docId) {
  let m = byDoc.get(docId);
  if (!m) { m = new Map(); byDoc.set(docId, m); }
  return m;
}

/** Approximate byte weight of one output's binary payload. */
function weigh(out) {
  if (!out) return 0;
  let n = 0;
  if (Array.isArray(out.images)) for (const b of out.images) n += b.length;
  if (Array.isArray(out.displays)) {
    for (const d of out.displays) if (d && typeof d.data === 'string') n += d.data.length;
  }
  return n;
}

export function getOutput(docId, key) {
  const m = byDoc.get(docId);
  return m ? m.get(key) : undefined;
}

export function setOutput(docId, key, out) {
  const m = docMap(docId);
  m.delete(key);          // re-insert so the Map's order is "least recent first"
  m.set(key, { ...out, at: Date.now() });
  enforceBudget();
}

export function deleteOutput(docId, key) {
  const m = byDoc.get(docId);
  if (m) m.delete(key);
}

export function clearDoc(docId) {
  byDoc.delete(docId);
}

export function clearAll() {
  byDoc.clear();
}

/** Drop every entry of `docId` whose key is not in `liveKeys`. Called after
 *  edits settle, so deleting or rewriting cells actually frees their results. */
export function gcDoc(docId, liveKeys) {
  const m = byDoc.get(docId);
  if (!m) return;
  for (const k of [...m.keys()]) if (!liveKeys.has(k)) m.delete(k);
}

/** Shed images from the oldest results once the in-memory payload grows past
 *  the budget. Text, results and errors are never dropped. */
function enforceBudget() {
  let total = 0;
  const all = [];
  for (const [docId, m] of byDoc) {
    for (const [key, out] of m) {
      const w = weigh(out);
      total += w;
      if (w) all.push({ docId, key, out, w, at: out.at || 0 });
    }
  }
  if (total <= IMAGE_BUDGET) return;
  all.sort((a, b) => a.at - b.at);
  for (const e of all) {
    if (total <= IMAGE_BUDGET) break;
    const stripped = { ...e.out, images: [], displays: [], trimmed: true };
    byDoc.get(e.docId).set(e.key, stripped);
    total -= e.w;
  }
}

/* ---------------- persistence (results live inside the .pltx) ----------------
   Reopening an engineering report must SHOW its results without re-running
   anything: the numbers, tables and figures are part of the deliverable.

   The document stays light because of three rules:
     * Only successful, finished results are stored.
     * `running`, timings and internal bookkeeping are dropped.
     * A per-document budget caps how much figure data is written; anything
       over it is stored without its images (they come back on re-run).
   The container itself is a deflated ZIP, so what lands on disk is close to
   the raw PNG size. */

const SAVE_BUDGET = 12 * 1024 * 1024;

/** Serialize a document's outputs for the `.pltx` container, or null when
 *  there is nothing worth saving. `codeHashes` maps cellKey -> code hash, so a
 *  result can be discarded on load if its cell changed meanwhile. */
export function serializeDoc(docId, codeHashes) {
  const m = byDoc.get(docId);
  if (!m || !m.size) return null;
  const cells = {};
  let budget = SAVE_BUDGET;
  let kept = 0;
  for (const [key, out] of m) {
    if (!out || out.running || out.ok !== true) continue;
    const codeHash = codeHashes ? codeHashes.get(key) : out.codeHash;
    if (!codeHash) continue;
    const w = weigh(out);
    const withMedia = w <= budget;
    if (withMedia) budget -= w;
    cells[key] = {
      codeHash,
      ok: true,
      stdout: out.stdout || '',
      stderr: out.stderr || '',
      result: out.result ?? null,
      render: out.render || null,
      count: out.count || null,
      ms: out.ms ?? null,
      displays: withMedia && Array.isArray(out.displays) ? out.displays : [],
      images: withMedia && Array.isArray(out.images) ? out.images : [],
    };
    kept++;
  }
  if (!kept) return null;
  return JSON.stringify({ v: 1, cells });
}

/** Load persisted outputs for a document. Results whose cell code no longer
 *  matches are dropped: a stale number is worse than no number. */
export function hydrateDoc(docId, json, codeHashes) {
  if (!json) return;
  let data;
  try { data = JSON.parse(json); } catch (_) { return; }
  if (!data || data.v !== 1 || !data.cells) return;
  const m = docMap(docId);
  for (const [key, out] of Object.entries(data.cells)) {
    const expect = codeHashes ? codeHashes.get(key) : out.codeHash;
    if (expect && out.codeHash !== expect) continue;
    m.set(key, { ...out, running: false, at: Date.now(), restored: true });
  }
  enforceBudget();
}

export const codeHash = hashString;
