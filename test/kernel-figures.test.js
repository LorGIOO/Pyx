// QAFUN-6 · one figure, one picture.
//
// These drive the REAL kernel over its stdin/stdout JSON protocol, exactly as
// the app does. Nothing is mocked: the bug was an interaction between two
// parts of kernel.py (the bare-expression result and the end-of-cell sweep),
// and only running both can show it is gone.
//
// Skipped on a machine without matplotlib, the way the LaTeX tests skip
// without an engine.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KERNEL = fileURLToPath(new URL('../src-tauri/python/kernel.py', import.meta.url));

const python = ['python', 'python3', 'py'].find((exe) => {
  const r = spawnSync(exe, ['-c', 'import matplotlib'], { encoding: 'utf8' });
  return r.status === 0;
});

const HEAD = "import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\n";

describe.skipIf(!python)('QAFUN-6 · a figure is never shown twice', () => {
  let proc;
  let buf = '';
  const waiting = new Map(); // id -> resolve
  let nextId = 1;

  beforeAll(async () => {
    proc = spawn(python, ['-u', KERNEL], { stdio: ['pipe', 'pipe', 'ignore'] });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;       // stray print
        let frame;
        try { frame = JSON.parse(line); } catch (_) { continue; }
        const done = waiting.get(frame.id);         // the handshake has no id
        if (done) { waiting.delete(frame.id); done(frame); }
      }
    });
  });

  afterAll(() => { try { proc.stdin.end(); proc.kill(); } catch (_) { /* gone */ } });

  // How many PICTURES a cell produced, wherever they came from: `displays`
  // (routed as the cell's result or through display()) and `images` (the
  // end-of-cell sweep) are two different fields and the bug was one figure
  // landing in both.
  const run = (code) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error('kernel did not answer')), 60000);
    waiting.set(id, (frame) => { clearTimeout(timer); resolve(frame); });
    proc.stdin.write(`${JSON.stringify({ id, code })}\n`);
  });
  const pictures = (r) => (r.images || []).length
    + (r.displays || []).filter((d) => d.kind === 'image' || d.kind === 'svg').length;

  it('a cell ending in `fig` shows it once', async () => {
    const r = await run(`${HEAD}fig, ax = plt.subplots()\nax.plot([1,2,3],[1,4,9])\nfig\n`);
    expect(r.ok).toBe(true);
    expect(pictures(r)).toBe(1);
  });

  it('display(fig) shows it once', async () => {
    const r = await run(`${HEAD}from pyx import display\nf, a = plt.subplots()\na.plot([1,2],[3,4])\ndisplay(f)\n`);
    expect(r.ok).toBe(true);
    expect(pictures(r)).toBe(1);
  });

  it('a plot with no bare expression is still captured', async () => {
    const r = await run(`${HEAD}plt.figure()\nplt.plot([1,2],[3,4])\n`);
    expect(r.ok).toBe(true);
    expect(pictures(r)).toBe(1);
  });

  it('two figures, one shown explicitly, still give two pictures', async () => {
    const r = await run(`${HEAD}a = plt.figure(); plt.plot([1,2],[1,2])\nb = plt.figure(); plt.plot([2,1],[1,2])\nb\n`);
    expect(r.ok).toBe(true);
    expect(pictures(r)).toBe(2);
  });

  it('the skip list does not leak into the next cell', async () => {
    await run(`${HEAD}fig, ax = plt.subplots()\nax.plot([1,2],[1,2])\nfig\n`);
    const r = await run(`${HEAD}plt.figure()\nplt.plot([3,4],[5,6])\n`);
    expect(r.ok).toBe(true);
    expect(pictures(r)).toBe(1);
  });
});
