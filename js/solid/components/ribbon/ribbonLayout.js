// Adaptive ribbon: fits the groups of the active tab to the width there is,
// the way Word's ribbon does (the Windows Ribbon framework calls it a scaling
// policy), instead of scrolling sideways.
//
// Every group has four sizes, written to `data-size` on its `.ribbon-group`
// and drawn by styles/ribbon.css:
//
//   large      as designed
//   medium     the small buttons keep only their icon, combos get narrower
//   small      icons only
//   collapsed  one button with the group's icon and name; it opens the whole
//              group, at full size, in a popover (RibbonGroup.jsx)
//
// Each tab declares the ORDER in which its groups give way, as a list of
// [group id, size] steps: what is used least shrinks first, and what must stay
// one click away (compiling) shrinks last and never collapses.
//
// The decision itself — which steps to apply for a given width — is
// `planRibbon`, a pure function over measured widths, so it can be tested
// without a browser. `createRibbonLayout` is the part that measures the DOM
// and applies the result.

import { createContext } from 'solid-js';

/** What RibbonGroup registers with. Null outside a <Ribbon>. */
export const RibbonLayoutContext = createContext(null);

const RANK = { large: 0, medium: 1, small: 2, collapsed: 3 };

// A layout that still fits is kept until the next larger one fits with this
// much room to spare. Without it the ribbon flips back and forth on the exact
// pixel where "Compilar y ver" becomes "Compilando…" and back.
export const HYSTERESIS = 8;

// Sub-pixel widths add up to fractions; a group row that is 0.3px "too wide"
// fits on screen.
const EPS = 0.5;

/**
 * Decide the size of every group.
 *
 * @param {object}   o
 * @param {string[]} o.ids        group ids, left to right
 * @param {Array}    o.steps      [[id, size], …] in the order to apply them
 * @param {string[]} o.pinned     groups that are never collapsed
 * @param {number}   o.available  width the groups may take together
 * @param {(id: string, size: string) => number} o.measure
 *                                width of one group at one size. A group's
 *                                width does not depend on the others (they do
 *                                not shrink or wrap), which is what lets each
 *                                step be measured on its own.
 * @param {number}   o.hysteresis spare room required before growing back
 * @param {object}   o.previous   the sizes applied by the last pass, if any
 * @returns {Record<string, string>} id → size
 */
export function planRibbon({
  ids, steps = [], pinned = [], available, measure, hysteresis = 0, previous = null,
}) {
  const sizes = {};
  const widths = {};
  let total = 0;
  for (const id of ids) {
    sizes[id] = 'large';
    widths[id] = measure(id, 'large');
    total += widths[id];
  }

  const fits = (spare) => total + spare <= available + EPS;
  let tight = null;   // first state that fits at all
  let loose = null;   // first state that fits with `hysteresis` to spare
  const kept = [];    // every state from `tight` to `loose`, both included
  const record = () => {
    if (!tight && fits(0)) tight = { ...sizes };
    if (tight) kept.push({ ...sizes });
    if (!loose && fits(hysteresis)) loose = { ...sizes };
  };
  record();

  const reduce = (id, size) => {
    if (!(id in sizes) || !(size in RANK)) return;      // a group this tab does not have
    if (RANK[size] <= RANK[sizes[id]]) return;          // already that small
    const w = measure(id, size);
    // A step that does not make its group narrower is undone and skipped: a
    // lone big button turned into a row with its text beside it is WIDER.
    if (!(w < widths[id])) return;
    total += w - widths[id];
    widths[id] = w;
    sizes[id] = size;
    record();
  };

  for (const [id, size] of steps) {
    if (loose) break;
    reduce(id, size);
  }
  // Out of declared steps and still too wide: collapse from the right. There
  // is never a horizontal scrollbar, whatever the tab declares.
  for (let i = ids.length - 1; i >= 0 && !loose; i--) {
    if (!pinned.includes(ids[i])) reduce(ids[i], 'collapsed');
  }

  if (!tight) return { ...sizes }; // nothing fits: the smallest there is

  const same = (a, b) => ids.every((id) => a[id] === b[id]);
  if (previous && ids.every((id) => id in previous) && Object.keys(previous).length === ids.length) {
    // What is on screen still fits, and nothing larger fits comfortably.
    if (kept.some((s) => same(s, previous))) return { ...previous };
    // Room was made: grow, but only as far as fits with room to spare.
    if (loose && ids.every((id) => RANK[previous[id]] >= RANK[loose[id]])) return loose;
  }
  return tight;
}

/**
 * The DOM side: watches the ribbon and its groups, and re-plans when
 * something that changes a width happens.
 *
 * @param {() => {steps?: Array, pinned?: string[]}} getPolicy  the active tab's
 */
export function createRibbonLayout(getPolicy) {
  let root = null;          // .ribbon-content
  let raf = 0;
  let lastWidth = -1;
  let previous = null;
  const groups = new Map(); // element → { id, el, content, isOpen, close }

  // Also the groups' contents, not just the ribbon: labels change on their
  // own ("Compilando…", the language, what a dropdown remembers).
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;

  // Always in a frame, never inside the observer callback: changing sizes
  // there is what raises "ResizeObserver loop completed with undelivered
  // notifications".
  function schedule() {
    if (raf || typeof requestAnimationFrame !== 'function') return;
    raf = requestAnimationFrame(() => { raf = 0; run(); });
  }

  function run() {
    if (!root || !groups.size) return;
    const width = root.clientWidth;
    // Hidden (zen mode keeps the ribbon mounted but display:none): there is
    // nothing to measure, and every group would "fit" in zero pixels.
    if (width === 0) return;

    const ordered = [];
    for (const el of root.children) {
      const g = groups.get(el);
      if (g) ordered.push(g);
    }
    if (!ordered.length) return;

    // A collapsed group that is open has lent its content to the popover, so
    // it cannot be measured. Leave everything as it is — unless the window
    // itself changed, in which case the popover closes like any menu would.
    const open = ordered.filter((g) => g.isOpen());
    if (open.length) {
      if (width === lastWidth) return;
      for (const g of open) g.close();
    }
    lastWidth = width;

    const cs = getComputedStyle(root);
    const available = width - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const byId = new Map(ordered.map((g) => [g.id, g]));
    const policy = getPolicy() || {};
    const plan = planRibbon({
      ids: ordered.map((g) => g.id),
      steps: policy.steps || [],
      pinned: policy.pinned || [],
      available,
      hysteresis: HYSTERESIS,
      previous,
      measure: (id, size) => {
        const el = byId.get(id).el;
        el.dataset.size = size;
        return el.getBoundingClientRect().width;
      },
    });
    // All of the above happened inside one frame, before paint: the trial
    // sizes are never seen, only this final one.
    for (const g of ordered) g.el.dataset.size = plan[g.id];
    previous = plan;
  }

  // A window resize is delivered BEFORE the frame's callbacks, the observer
  // AFTER its layout. Listening to both means a drag of the window border is
  // answered in the same frame, with no frame of clipped buttons in between.
  if (typeof window !== 'undefined') window.addEventListener('resize', schedule);
  // Icon and label widths are wrong until the UI font has loaded.
  if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
    document.fonts.ready.then(schedule).catch(() => {});
  }

  return {
    schedule,
    setRoot(el) {
      root = el;
      if (ro && el) ro.observe(el);
      schedule();
    },
    /** Called by each RibbonGroup when it mounts; returns its unregister. */
    register(group) {
      groups.set(group.el, group);
      if (ro && group.content) ro.observe(group.content);
      schedule();
      return () => {
        groups.delete(group.el);
        if (ro && group.content) ro.unobserve(group.content);
        schedule();
      };
    },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (ro) ro.disconnect();
      if (typeof window !== 'undefined') window.removeEventListener('resize', schedule);
      groups.clear();
      root = null;
    },
  };
}
