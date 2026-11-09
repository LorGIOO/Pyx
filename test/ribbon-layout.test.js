// The adaptive ribbon's decision — which groups shrink, in what order, for a
// given width — is a pure function over measured widths. These tests feed it
// a table of widths instead of a DOM.
import { describe, it, expect } from 'vitest';
import { planRibbon } from '../js/solid/components/ribbon/ribbonLayout.js';
import { placePopup } from '../js/solid/components/createAnchoredPopup.js';

// Width of each group at each size. A missing size means "this group looks
// the same at that size" (it falls back to the next larger one that exists),
// which is how CSS behaves for a group with no rule for a size.
const HOME = {
  clipboard: { large: 140, medium: 80, collapsed: 60 },
  compile: { large: 160, medium: 100, small: 60, collapsed: 60 },
  format: { large: 120, collapsed: 60 },
  insert: { large: 100, medium: 85, collapsed: 60 },
  table: { large: 150, collapsed: 60 },
};
const ORDER = ['large', 'medium', 'small', 'collapsed'];
function measurer(table, log) {
  return (id, size) => {
    if (log) log.push(`${id}:${size}`);
    for (let i = ORDER.indexOf(size); i >= 0; i--) {
      if (table[id][ORDER[i]] != null) return table[id][ORDER[i]];
    }
    throw new Error(`no width for ${id}`);
  };
}
const STEPS = [
  ['table', 'collapsed'],
  ['insert', 'medium'],
  ['clipboard', 'medium'],
  ['insert', 'collapsed'],
  ['compile', 'medium'],
  ['clipboard', 'collapsed'],
  ['format', 'collapsed'],
  ['compile', 'small'],
];
const ids = Object.keys(HOME);
const plan = (available, extra = {}) => planRibbon({
  ids, steps: STEPS, pinned: ['compile'], available, measure: measurer(HOME), ...extra,
});
const widthOf = (sizes, table = HOME) => Object.entries(sizes)
  .reduce((a, [id, s]) => a + measurer(table)(id, s), 0);

describe('planRibbon', () => {
  it('leaves every group large when they all fit', () => {
    expect(plan(670)).toEqual({
      clipboard: 'large', compile: 'large', format: 'large', insert: 'large', table: 'large',
    });
  });

  it('applies the declared steps in order, and only as many as needed', () => {
    // 670 at full size. One step (table → collapsed) brings it to 580.
    expect(plan(600)).toMatchObject({ table: 'collapsed', insert: 'large', clipboard: 'large' });
    // 560 needs the second step too (insert → medium: 565) and the third (505).
    expect(plan(560)).toMatchObject({ table: 'collapsed', insert: 'medium', clipboard: 'medium', compile: 'large' });
    // The result always fits.
    for (let w = 700; w >= 310; w -= 7) expect(widthOf(plan(w))).toBeLessThanOrEqual(w);
  });

  it('never stops early: the layout chosen is the first that fits', () => {
    // Reference: walk the steps by hand and stop at the first layout that fits.
    const reference = (w) => {
      const sizes = Object.fromEntries(ids.map((id) => [id, 'large']));
      for (const [id, size] of STEPS) {
        if (widthOf(sizes) <= w) break;
        sizes[id] = size;
      }
      return sizes;
    };
    for (let w = 700; w >= 300; w -= 1) expect(plan(w)).toEqual(reference(w));
  });

  it('skips a step that does not make its group narrower', () => {
    // A lone big button turned into a row with its text is WIDER than the
    // button: the step is undone and the next one is used instead.
    const table = {
      a: { large: 100, medium: 130, collapsed: 60 },
      b: { large: 100, medium: 70, collapsed: 60 },
    };
    const sizes = planRibbon({
      ids: ['a', 'b'], steps: [['a', 'medium'], ['b', 'medium']], available: 180, measure: measurer(table),
    });
    expect(sizes).toEqual({ a: 'large', b: 'medium' });
  });

  it('ignores steps for groups the tab does not have, and steps that are not smaller', () => {
    const table = { a: { large: 100, collapsed: 50 }, b: { large: 100, medium: 80, collapsed: 50 } };
    const sizes = planRibbon({
      ids: ['a', 'b'],
      steps: [['ghost', 'collapsed'], ['a', 'collapsed'], ['a', 'medium'], ['b', 'medium']],
      available: 135,
      measure: measurer(table),
    });
    // a → collapsed (150), then "a → medium" must not grow it back; b → medium (130).
    expect(sizes).toEqual({ a: 'collapsed', b: 'medium' });
  });

  it('collapses from the right when the declared steps are not enough', () => {
    const table = {
      a: { large: 100, collapsed: 40 }, b: { large: 100, collapsed: 40 }, c: { large: 100, collapsed: 40 },
    };
    const run = (available) => planRibbon({ ids: ['a', 'b', 'c'], steps: [], available, measure: measurer(table) });
    expect(run(250)).toEqual({ a: 'large', b: 'large', c: 'collapsed' });
    expect(run(190)).toEqual({ a: 'large', b: 'collapsed', c: 'collapsed' });
    expect(run(125)).toEqual({ a: 'collapsed', b: 'collapsed', c: 'collapsed' });
  });

  it('never collapses a pinned group, however narrow the window', () => {
    for (const w of [400, 320, 200, 50, 0]) expect(plan(w).compile).not.toBe('collapsed');
    // At the very end it is icons only, and everything else is collapsed.
    expect(plan(0)).toEqual({
      clipboard: 'collapsed', compile: 'small', format: 'collapsed', insert: 'collapsed', table: 'collapsed',
    });
  });

  it('returns the smallest layout when nothing fits', () => {
    const sizes = plan(10);
    expect(widthOf(sizes)).toBe(300);
  });

  it('keeps the layout on screen until the larger one fits with room to spare', () => {
    const H = 8;
    // 580 is "table collapsed". At 583 the full-size layout (670) does not fit.
    const small = plan(583, { hysteresis: H });
    expect(small.table).toBe('collapsed');
    // The window grows to exactly what the full layout needs, then a little
    // more: still not enough spare room to switch back.
    expect(plan(670, { hysteresis: H, previous: small })).toEqual(small);
    expect(plan(676, { hysteresis: H, previous: small })).toEqual(small);
    // With the margin, it grows.
    expect(plan(678, { hysteresis: H, previous: small }).table).toBe('large');
    // Coming from the large side there is nothing to hold on to: it fits, so it stays.
    const large = plan(678, { hysteresis: H });
    expect(plan(670, { hysteresis: H, previous: large })).toEqual(large);
    // And one pixel less shrinks it at once — hysteresis never allows overflow.
    expect(plan(669, { hysteresis: H, previous: large }).table).toBe('collapsed');
  });

  it('does not flip when a label changes width on the boundary', () => {
    // "Compilar y ver" ↔ "Compilando…": the compile group is 6px wider while
    // a compile runs. At a width where only the narrow label fits at full
    // size, the layout must settle instead of alternating on every compile.
    const H = 8;
    const idle = HOME;
    const busy = { ...HOME, compile: { ...HOME.compile, large: 166 } };
    const at = (table, previous) => planRibbon({
      ids, steps: STEPS, pinned: ['compile'], available: 672, hysteresis: H, previous, measure: measurer(table),
    });
    let cur = at(idle, null);
    expect(cur.table).toBe('large');
    cur = at(busy, cur);            // 676 > 672: has to shrink
    expect(cur.table).toBe('collapsed');
    const seen = [];
    for (let i = 0; i < 6; i++) { cur = at(i % 2 ? busy : idle, cur); seen.push(cur.table); }
    expect(new Set(seen).size).toBe(1); // settled
  });

  it('ignores a previous layout from another tab', () => {
    const sizes = plan(670, { hysteresis: 8, previous: { mode: 'collapsed', basic: 'large' } });
    expect(sizes.table).toBe('large');
  });

  it('measures each group at each size at most once', () => {
    const log = [];
    planRibbon({ ids, steps: STEPS, pinned: ['compile'], available: 0, measure: measurer(HOME, log) });
    expect(new Set(log).size).toBe(log.length);
  });
});

describe('placePopup', () => {
  const vp = { width: 800, height: 600 };
  const anchor = (left, top, w = 100, h = 20) => ({ left, top, right: left + w, bottom: top + h });

  it('opens under the anchor, left-aligned, when there is room', () => {
    expect(placePopup(anchor(50, 100), { width: 200, height: 150 }, vp)).toEqual({ left: 50, top: 121, maxHeight: null });
  });

  it('is pulled back inside the right edge', () => {
    const p = placePopup(anchor(700, 100), { width: 200, height: 150 }, vp);
    expect(p.left + 200).toBeLessThanOrEqual(800 - 4);
    expect(p.top).toBe(121);
  });

  it('never starts left of the window, even when wider than it', () => {
    expect(placePopup(anchor(10, 100), { width: 900, height: 50 }, vp).left).toBe(4);
  });

  it('flips above the anchor when there is no room below', () => {
    const p = placePopup(anchor(50, 500), { width: 200, height: 150 }, vp);
    expect(p).toEqual({ left: 50, top: 500 - 1 - 150, maxHeight: null });
  });

  it('caps the height on the roomier side when neither fits', () => {
    const below = placePopup(anchor(50, 100), { width: 200, height: 900 }, vp);
    expect(below.top).toBe(121);
    expect(below.maxHeight).toBe(600 - 4 - 121);
    const above = placePopup(anchor(50, 450), { width: 200, height: 900 }, vp);
    expect(above.top).toBe(4);
    expect(above.maxHeight).toBe(450 - 1 - 4);
  });

  it('can line up with the right edge of the anchor', () => {
    expect(placePopup(anchor(600, 100), { width: 220, height: 50 }, vp, { align: 'end' }).left).toBe(480);
  });
});
