// The dependency graph checked against Python itself.
//
// Hundreds of random documents, each edited at random (a cell changed,
// inserted or deleted). For each, in Pyx's own kernel: run the old document,
// then run ONLY what the planner says on top of that namespace (with early
// cutoff) — and compare with a full run of the new document from scratch. Every name and every value must match.
// That is the planner's whole promise; this test is what keeps it.
// Skipped on a machine without Python.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzePython } from '../js/editor/py-deps.js';
import { planRun, executePlan } from '../js/editor/dep-plan.js';

const python = ['python3', 'python', 'py'].find((exe) => {
  const r = spawnSync(exe, ['-c', 'import sys; print(sys.version_info >= (3, 8))'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'True';
});

// Small deterministic PRNG so a failure can be reproduced from its seed.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const NAMES = ['a', 'b', 'c', 'd', 'e', 'p', 'q', 'r', 's', 'u'];
function makeCell(r) {
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const x = pick(NAMES), y = pick(NAMES), z = pick(NAMES), k = 1 + Math.floor(r() * 5);
  const t = [
    `${x} = ${k}`,
    `${x} = ${y} + ${k}`,
    `${x} = ${y} * ${z}`,
    `${x} += ${k}`,
    `${x} = ${x} + ${y}`,
    'lst = []',
    `lst.append(${y})`,
    `${x} = len(lst)`,
    `${x} = sum(lst)`,
    `def f(v):\n    return v * ${y}`,
    `${x} = f(${z})`,
    'def g():\n    lst.append(1)',
    'g()',
    `if ${y} > 3:\n    ${x} = 1\nelse:\n    ${x} = 2`,
    `for i in range(${y} % 3):\n    ${x} = i`,
    `${x} = random.random()`,
    `random.seed(${k})`,
    `${x}, ${y} = ${z}, ${k}`,
    `del ${x}`,
    `${x} = [q * ${y} for q in range(3)]`,
    `${x} = (lambda t: t + ${y})(1)`,
    'dd = {}',
    `dd['k'] = ${y}`,
    `${x} = dd.get('k', 0)`,
    `${x} = ${y} if ${z} else ${k}`,
    `def h(m):\n    m.append(${k})\n    return len(m)`,
    `${x} = h(lst)`,
    `${x} = sorted(lst)[:1]`,
    `${x} = max(${y}, ${z})`,
  ];
  return pick(t);
}

const PRELUDE = 'import random\nrandom.seed(1)\na = b = c = d = e = p = q = r = s = u = 1\nlst = []\ndd = {}\ndef f(v):\n    return v\ndef g():\n    pass\ndef h(m):\n    return 0';

function makeCase(seed) {
  const r = rng(seed);
  const n = 3 + Math.floor(r() * 6);
  let nextKey = 0;
  const before = [{ key: `k${nextKey++}`, code: PRELUDE }];
  for (let i = 0; i < n; i++) before.push({ key: `k${nextKey++}`, code: makeCell(r) });
  const after = before.map((c) => ({ ...c }));
  const edits = 1 + Math.floor(r() * 2);
  for (let e = 0; e < edits; e++) {
    const op = r();
    const at = 1 + Math.floor(r() * (after.length - 1));
    if (op < 0.5 && after.length > 1) after[at] = { key: after[at].key, code: makeCell(r) };
    else if (op < 0.8) after.splice(at, 0, { key: `k${nextKey++}`, code: makeCell(r) });
    else if (after.length > 2) after.splice(at, 1);
  }
  return { before, after };
}

const KERNEL = fileURLToPath(new URL('../src-tauri/python/kernel.py', import.meta.url));

function startKernel() {
  const proc = spawn(python, ['-u', KERNEL], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const waiting = new Map();
  let buf = '';
  let nextId = 1;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      const done = waiting.get(frame.id);
      if (done) { waiting.delete(frame.id); done(frame); }
    }
  });
  const send = (req) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    proc.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
  });
  return { send, close: () => { try { proc.stdin.end(); proc.kill(); } catch (_) { /* gone */ } } };
}

// The document's values, as one comparable string.
const SNAPSHOT = "repr(sorted((k, repr(v)) for k, v in globals().items() if not k.startswith('_') "
  + "and k not in ('random', 'In', 'Out', 'exit', 'quit', 'get_ipython') and not callable(v)))";

describe.skipIf(!python)('dependency graph vs. a full run, in the real kernel', () => {
  let k;
  beforeAll(() => { k = startKernel(); });
  afterAll(() => k && k.close());

  it('running only the planned cells gives the same namespace as running everything', async () => {
    const runAll = async (codes) => {
      let last = null;
      await k.send({ code: '', reset: true });
      for (const code of codes) {
        last = await k.send({ code, watch: [] });
        if (!last.ok) return null;
      }
      return last;
    };
    const snap = async () => (await k.send({ evals: [SNAPSHOT] })).evals[SNAPSHOT].value;
    let checked = 0, graph = 0, old = 0, executed = 0;
    for (let seed = 1; checked < 250 && seed < 4000; seed++) {
      const { before, after } = makeCase(seed);
      // Ground truth: the new document from scratch.
      if (!(await runAll(after.map((c) => c.code)))) continue;
      const full = await snap();
      // The old document, as the namespace the app would hold.
      const last = await runAll(before.map((c) => c.code));
      if (!last) continue;
      const prog = (cells) => cells.map((c) => ({ key: c.key, hash: c.code, info: analyzePython(c.code) }));
      const pb = prog(before);
      const imm = last.immutable || [];
      const planB = planRun({ program: pb, ran: new Map(), history: [], immutable: imm });
      const ran = new Map(pb.map((c, i) => [c.key, { hash: c.hash, D: planB.effects[i].D }]));
      const history = pb.map((c) => ({ key: c.key, hash: c.hash }));
      const pa = prog(after);
      const plan = planRun({ program: pa, ran, history, immutable: imm });
      if (plan.mode !== 'graph') await k.send({ code: '', reset: true });
      const out = await executePlan(plan, {
        run: (i, watch) => k.send({ code: after[i].code, watch }),
        forget: (names) => k.send({ forget: names }),
      });
      const inc = await snap();
      if (!out.ok || inc !== full) {
        throw new Error(`seed ${seed}: ${out.ok ? 'different values' : 'cell ' + out.failedAt + ' failed'}\nbefore:\n${before.map((c) => c.code).join('\n---\n')}\n\nafter:\n${after.map((c) => c.code).join('\n---\n')}\n\nplan ${JSON.stringify(plan.run)} seeds ${JSON.stringify([...(plan.seeds || [])])} forget ${JSON.stringify(plan.forget)} ran ${JSON.stringify(out.ran)}\ninc  ${inc}\nfull ${full}`);
      }
      checked++;
      graph += plan.run.length;
      executed += out.ran.length;
      let m = 0;
      while (m < before.length && m < after.length && before[m].code === after[m].code) m++;
      old += m === before.length ? after.length - m : after.length;
    }
    expect(checked).toBeGreaterThan(200);
    // It saves work over the old rule (re-run from the first changed cell when
    // everything above is untouched, otherwise everything).
    expect(executed).toBeLessThan(old * 0.85);
  }, 120000);
});
