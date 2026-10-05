// handcalcs typeset `a = 2` as `a` on one line and `= 2` on the next.
//
// The cause was not the document: handcalcs keeps every `set_option` in a
// dict inside its own module, and the reset a compile does before a full
// re-run only emptied the namespace. One `set_option("math_environment_start",
// "gathered")` — a line since deleted, or another open document, since all of
// them share the kernel — kept `gathered` for every later %%render cell, and in
// `gathered` each `&` becomes a new row.
//
// These drive the REAL kernel over its JSON protocol, the way the app does.
// Skipped on a machine without handcalcs.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KERNEL = fileURLToPath(new URL('../src-tauri/python/kernel.py', import.meta.url));

const python = ['python', 'python3', 'py'].find((exe) => {
  const r = spawnSync(exe, ['-c', 'import handcalcs.handcalcs'], { encoding: 'utf8' });
  return r.status === 0;
});

// The first request imports IPython and handcalcs: seconds on a cold disk.
describe.skipIf(!python)('handcalcs options do not outlive a kernel reset', { timeout: 60000 }, () => {
  let proc;
  let buf = '';
  const waiting = new Map();
  let nextId = 1;

  beforeAll(() => {
    proc = spawn(python, ['-u', KERNEL], { stdio: ['pipe', 'pipe', 'ignore'] });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let frame;
        try { frame = JSON.parse(line); } catch (_) { continue; }
        const done = waiting.get(frame.id);
        if (done) { waiting.delete(frame.id); done(frame); }
      }
    });
  });

  afterAll(() => { try { proc.stdin.end(); proc.kill(); } catch (_) { /* gone */ } });

  const run = (code, reset = false) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error('kernel did not answer')), 60000);
    waiting.set(id, (frame) => { clearTimeout(timer); resolve(frame); });
    proc.stdin.write(`${JSON.stringify({ id, code, reset })}\n`);
  });

  const SETUP = 'import handcalcs.render\nhandcalcs.set_option("param_columns", 3)\n';
  const RENDER = '%%render\na = 2\nb = 4';

  it('an option set before the reset is gone after it', async () => {
    await run(`${SETUP}handcalcs.set_option("math_environment_start", "gathered")\n`
      + 'handcalcs.set_option("math_environment_end", "gathered")\n');
    const before = await run(RENDER);
    expect(before.render).toContain('gathered'); // the option really was in effect

    await run('', true);          // what a compile does before a full re-run
    await run(SETUP);             // the option line has been deleted
    const after = await run(RENDER);
    expect(after.ok).toBe(true);
    expect(after.render).toContain('\\begin{aligned}');
    expect(after.render).not.toContain('gathered');
  });

  it('an option the document still sets is still honoured after the reset', async () => {
    await run('', true);
    await run(`${SETUP}handcalcs.set_option("line_break", "\\\\\\\\[4pt]")\n`);
    const r = await run(RENDER);
    expect(r.render).toContain('\\\\[4pt]');
  });

  it('%%render arguments are parsed by handcalcs itself', async () => {
    await run('', true);
    await run(SETUP);
    const r = await run('%%render params\nh = 12\nk = 0.35');
    expect(r.ok).toBe(true);
    // `params` lays the values out side by side: the second one opens a new
    // column (`&k`) on the same row instead of a row of its own.
    expect(r.render).toMatch(/h &= 12[^\n]*\n\s*&k &= 0\.35/);
  });
});
