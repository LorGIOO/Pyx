import { describe, it, expect } from 'vitest';
import { analyzePython } from '../js/editor/py-deps.js';
import { planRun, downstreamOf } from '../js/editor/dep-plan.js';
import { createExecState } from '../js/editor/exec-state.js';

const set = (s) => [...s].sort();

describe('py-deps: what a cell defines and reads', () => {
  it('assignments, imports and reads', () => {
    const i = analyzePython('import numpy as np\nx = np.linspace(0, L, n)\ny = x * 2');
    expect(set(i.defs)).toEqual(['np', 'x', 'y']);
    expect(set(i.reads)).toEqual(['L', 'n']);
    expect(i.imports.get('np')).toBe('numpy');
  });

  it('a name bound earlier in the cell is not a read; one bound conditionally is', () => {
    expect(set(analyzePython('a = 1\nb = a').reads)).toEqual([]);
    expect(set(analyzePython('if c:\n    a = 1\nb = a').reads)).toEqual(['a', 'c']);
  });

  it('x = x + 1 and x += 1 read the previous x', () => {
    expect(set(analyzePython('x = x + 1').reads)).toEqual(['x']);
    expect(set(analyzePython('x += 1').reads)).toEqual(['x']);
  });

  it("a function's free names are reads of the cell; params and locals are not", () => {
    const i = analyzePython('def f(t, k=K):\n    z = t * g\n    return z');
    expect(set(i.defs)).toEqual(['f']);
    expect(set(i.reads)).toEqual(['K', 'g']);
  });

  it('comprehension and lambda variables stay local', () => {
    expect(set(analyzePython('r = [i * s for i in range(n)]').reads)).toEqual(['n', 'range', 's']);
    expect(set(analyzePython('h = lambda u: u + c').reads)).toEqual(['c']);
  });

  it('records mutations of objects from other cells', () => {
    const i = analyzePython('lst.append(3)\nd["k"] = v\nobj.a = 1');
    expect(i.muts.map((m) => `${m.kind}:${m.root}`)).toEqual(['method:lst', 'strong:d', 'strong:obj']);
    // An object created in the same cell is not another cell's business.
    expect(analyzePython('l2 = []\nl2.append(1)').muts).toEqual([]);
  });

  it('a function that modifies a global carries that effect', () => {
    const i = analyzePython('def add(v):\n    data.append(v)');
    expect(i.fns.get('add').muts[0]).toMatchObject({ kind: 'method', root: 'data', method: 'append' });
  });

  it('constructs it cannot follow make the cell opaque', () => {
    expect(analyzePython('%timeit f()').opaque).toBeTruthy();
    expect(analyzePython('!pip install x').opaque).toBeTruthy();
    expect(analyzePython('exec("a = 1")').opaque).toBeTruthy();
    expect(analyzePython('from math import *').opaque).toBeTruthy();
    expect(analyzePython('def f():\n    global G\n    G = 1').opaque).toBeTruthy();
    expect(analyzePython('x = (').opaque).toBeTruthy();
    // The handcalcs header is Pyx's own: not opaque.
    expect(analyzePython('%%render\nM = q * L**2 / 8').opaque).toBe(false);
  });
});

/** A program from cell sources; keys c0, c1… and the code as its hash. */
const prog = (codes) => codes.map((code, i) => ({ key: `c${i}`, hash: code, info: analyzePython(code) }));
/** The namespace after running `codes` from scratch. */
function ranAll(codes, immutable = []) {
  const p = prog(codes);
  const plan = planRun({ program: p, ran: new Map(), history: [], immutable });
  return {
    ran: new Map(p.map((c, i) => [c.key, { hash: c.hash, D: plan.effects[i].D }])),
    history: p.map((c) => ({ key: c.key, hash: c.hash })),
  };
}
const plan = (before, after, extra = {}) => {
  const { ran, history } = ranAll(before);
  return planRun({ program: prog(after), ran, history, ...extra });
};

describe('dep-plan: only what a change reaches', () => {
  const doc = ['import numpy as np\nimport matplotlib.pyplot as plt', 'data = np.arange(n)',
    'sim = np.cumsum(data)', 'fig = plt.plot(sim)', 'note = "x"'];

  it('nothing changed → nothing runs', () => {
    expect(plan(doc, doc).run).toEqual([]);
  });

  it('editing the last cells does not re-run the simulation', () => {
    const after = [...doc];
    after[3] = 'fig = plt.plot(sim, color="r")';
    expect(plan(doc, after).run).toEqual([3]);
  });

  it('editing an upstream cell re-runs everything that depends on it, and only that', () => {
    const after = [...doc];
    after[1] = 'data = np.arange(2 * n)';
    expect(plan(doc, after).run).toEqual([1, 2, 3]);
  });

  it('x = x + 1 re-runs the cell that defined x first (no double increment)', () => {
    const before = ['x = 1', 'x = x + 1', 'y = x'];
    const after = ['x = 1', 'x = x + 2', 'y = x'];
    expect(plan(before, after).run).toEqual([0, 1, 2]);
  });

  it('a list modified by another cell is rebuilt before it is modified again', () => {
    const before = ['lst = []', 'lst.append(1)', 'n = len(lst)'];
    const after = ['lst = []', 'lst.append(2)', 'n = len(lst)'];
    expect(plan(before, after).run).toEqual([0, 1, 2]);
  });

  it('a pure method does not count as a modification', () => {
    const before = ['a = make()', 'm = a.mean()', 'z = 1'];
    const after = ['a = make()', 'm = a.mean() * 2', 'z = 1'];
    expect(plan(before, after).run).toEqual([1]);
  });

  it('an immutable value handed to a function is not modified by it', () => {
    const before = ['b = 2.0', 'def area(x):\n    return x * x', 'A = area(b)'];
    const after = ['b = 2.0', 'def area(x):\n    return x * x', 'A = area(b) + 1'];
    expect(plan(before, after).run).toEqual([0, 2]);
    const imm = ['b', 'area', 'A'];
    const { ran, history } = ranAll(before, imm);
    expect(planRun({ program: prog(after), ran, history, immutable: imm }).run).toEqual([2]);
  });

  it('a later redefinition is re-applied after an earlier one re-runs', () => {
    const before = ['a = 1', 'b = a', 'a = 5', 'c = a'];
    const after = ['a = 2', 'b = a', 'a = 5', 'c = a'];
    expect(plan(before, after).run).toEqual([0, 1, 2, 3]);
  });

  it('a removed cell: its names are forgotten and their readers re-run', () => {
    const before = ['a = 1', 'b = 2', 'c = b + 1'];
    const after = ['a = 1', 'c = b + 1'];
    const p = planRun({ program: [prog(after)[0], { key: 'c2', hash: after[1], info: analyzePython(after[1]) }], ...ranAll(before) });
    expect(p.forget).toContain('b');
    expect(p.run).toEqual([1]);
  });

  it('random numbers: a seed and every draw after it run together', () => {
    const before = ['import numpy as np\nnp.random.seed(0)', 'x = np.random.rand()', 'y = np.random.rand()'];
    const after = [...before];
    after[2] = 'y = np.random.rand() * 2';
    expect(plan(before, after).run).toEqual([0, 1, 2]);
  });

  it('a function that modifies a global makes its callers modify it too', () => {
    const before = ['data = []', 'def add(v):\n    data.append(v)', 'add(1)', 'n = len(data)'];
    const after = [...before];
    after[2] = 'add(2)';
    expect(plan(before, after).run).toEqual([0, 1, 2, 3]);
  });

  it('an opaque cell falls back to the exact prefix rule', () => {
    const before = ['a = 1', '%timeit a', 'b = 2'];
    const after = ['a = 1', '%timeit a', 'b = 2', 'c = 3'];
    expect(plan(before, after)).toMatchObject({ mode: 'prefix', run: [3] });
    const edited = ['a = 9', '%timeit a', 'b = 2'];
    expect(plan(before, edited).mode).toBe('full');
  });

  it('forced cells run even when unchanged, with what depends on them', () => {
    expect(plan(doc, doc, { forced: ['c2'] }).run).toEqual([2, 3]);
  });
});

describe('downstreamOf: the editor marks', () => {
  it('marks the cells a changed cell feeds, not the others', () => {
    const infos = ['a = 1', 'b = a + 1', 'c = 3', 'd = b * c'].map(analyzePython);
    expect([...downstreamOf(infos, new Set([0]))].sort()).toEqual([1, 3]);
  });
});

describe('exec-state', () => {
  it('a reset, then runs, then a plan', () => {
    const st = createExecState();
    st.reset('/p');
    const p = prog(['a = 1', 'b = a']);
    let pl = st.plan(p, { dir: '/p' });
    expect(pl.run).toEqual([0, 1]);
    p.forEach((c, i) => st.record(c.key, c.hash, '/p', [], pl.effects[i].D));
    pl = st.plan(p, { dir: '/p' });
    expect(pl.run).toEqual([]);
  });

  it('an unknown namespace or another folder means a full run', () => {
    const st = createExecState();
    st.invalidate();
    expect(st.plan(prog(['a = 1']), { dir: '/p' }).mode).toBe('full');
    st.reset('/p');
    expect(st.plan(prog(['a = 1']), { dir: '/q' }).mode).toBe('full');
  });

  it('a failed cell runs again next time', () => {
    const st = createExecState();
    st.reset('/p');
    const p = prog(['a = 1', 'b = 1 / 0']);
    st.record('c0', p[0].hash, '/p', [], new Set(['a']));
    st.fail('c1', new Set(['b']));
    expect(st.plan(p, { dir: '/p' }).run).toEqual([1]);
  });
});

describe('dep-plan: a manual run (Mayús+Intro)', () => {
  const run = (before, after, forced, ranKeys) => {
    const { ran, history } = ranAll(before);
    if (ranKeys) for (const k of [...ran.keys()]) if (!ranKeys.includes(k)) ran.delete(k);
    return planRun({ program: prog(after), ran, history, forced, interactive: true });
  };

  it('runs the cell and what depends on it — not other edited cells', () => {
    const before = ['a = 1', 'b = a + 1', 'c = 5', 'd = c * 2'];
    const after = ['a = 2', 'b = a + 1', 'c = 6', 'd = c * 2'];
    const p = run(before, after, ['c0']);
    expect(p.run).toEqual([0, 1]);
  });

  it('a never-run cell that provides an input runs first; unrelated ones do not', () => {
    const cells = ['a = 1', 'z = 9', 'b = a + 1'];
    const p = run(cells, cells, ['c2'], []);
    expect(p.run).toEqual([0, 2]);
  });

  it('a single file does not delete the names of cells from other files', () => {
    const { ran, history } = ranAll(['a = 1']);
    ran.set('other.tex::x', { hash: 'q = 1', D: new Set(['q']) });
    const p = planRun({ program: prog(['a = 1', 'b = q']), ran, history, forced: ['c1'], interactive: true, owned: (k) => k.startsWith('c') });
    expect(p.forget).toEqual([]);
  });
});
