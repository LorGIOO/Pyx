// The kernel's guarantees, driven through its real JSON protocol the way the
// app drives it. Each one was a way to hang the app, lose the session or
// print a wrong number, found by testing the kernel hundreds of ways:
//   * output below Python (os.system, a child process, C code) cannot reach
//     the protocol pipe, and a child cannot read the app's requests;
//   * a Stop pressed while nothing runs is harmless;
//   * any string, even one Rust's JSON parser rejects, arrives;
//   * \py{} values are typeset strictly and a preview never mutates state;
//   * a library the document monkeypatched is never trusted after a reset.
// Skipped on a machine without Python.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KERNEL = fileURLToPath(new URL('../src-tauri/python/kernel.py', import.meta.url));

const python = ['python', 'python3', 'py'].find((exe) => {
  const r = spawnSync(exe, ['-c', 'import sys; print(sys.version_info >= (3, 8))'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'True';
});

function startKernel() {
  const proc = spawn(python, ['-u', KERNEL], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const waiting = new Map();
  const stray = [];
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
      let frame;
      try { frame = JSON.parse(line); } catch (_) { stray.push(line); continue; }
      if (frame.type === 'ready') continue;
      const done = waiting.get(frame.id);
      if (done) { waiting.delete(frame.id); done(frame); } else stray.push(line);
    }
  });
  const send = (req) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`kernel did not answer ${JSON.stringify(req)}`)), 50000);
    waiting.set(id, (f) => { clearTimeout(timer); resolve(f); });
    proc.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
  });
  return {
    proc,
    stray,
    run: (code, extra = {}) => send({ code, ...extra }),
    evals: (evals, extra = {}) => send({ evals, ...extra }).then((f) => f.evals),
    lint: (cells) => send({ lint: cells }).then((f) => f.lint),
    raw: (obj) => proc.stdin.write(`${JSON.stringify(obj)}\n`),
    close: () => { try { proc.stdin.end(); proc.kill(); } catch (_) { /* gone */ } },
  };
}

describe.skipIf(!python)('kernel protocol guarantees', { timeout: 60000 }, () => {
  let k;
  beforeAll(() => { k = startKernel(); });
  afterAll(() => k.close());

  it('output written below Python lands in the cell, never in the protocol', async () => {
    const r = await k.run("import os, sys, subprocess\nos.system('echo desde-cmd')\n"
      + "subprocess.run([sys.executable, '-c', 'import sys; sys.stdout.write(\"sin-salto\")'])\n"
      + "os.write(1, b'bajo-nivel')\nNone");
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('desde-cmd');
    expect(r.stdout).toContain('sin-salto');
    expect(r.stdout).toContain('bajo-nivel');
    expect((await k.run('1 + 1')).result).toBe('2');
    expect(k.stray).toEqual([]);
  });

  it('a child process reading stdin gets EOF instead of the app\'s requests', async () => {
    const r = await k.run("import subprocess, sys\nsubprocess.run([sys.executable, '-c', "
      + "'import sys; print(repr(sys.stdin.read()))'], capture_output=True, text=True).stdout.strip()");
    expect(r.result).toBe("\"''\"");
    expect((await k.run('3')).result).toBe('3');
  });

  it('Stop pressed while nothing runs does not kill the kernel', async () => {
    await k.run('x = 5');
    k.raw({ type: 'interrupt' });
    k.raw({ type: 'interrupt' });
    const r = await k.run('x * 2');
    expect(r.result).toBe('10');
  });

  it('a lone surrogate still arrives as a frame', async () => {
    const r = await k.run("print('\\ud800')\n'ok'");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("'ok'");
    expect((await k.run('4')).result).toBe('4');
  });

  it('cells run in __main__', async () => {
    expect((await k.run('__name__')).result).toBe("'__main__'");
  });

  it('\\py{} values are strict and never silently wrong', async () => {
    const v = await k.evals(['0.1 + 0.2', '12345678901234.5', "f'{0.25:.1%}'", '1e-300',
      '-0.0', "float('nan')", "{'a': 1}", '10**20 + 0.0']);
    expect(v['0.1 + 0.2'].value).toBe('0.3');
    expect(v['12345678901234.5'].value).toBe('12345678901234.5');
    expect(v["f'{0.25:.1%}'"].value).toBe('25.0\\%');
    expect(v['1e-300'].value).toBe('\\ensuremath{1\\times10^{-300}}');
    expect(v['-0.0'].value).toBe('0');
    expect(v["float('nan')"].ok).toBe(false);
    expect(v["{'a': 1}"].value).toBe("\\{'a': 1\\}");
    expect(v['10**20 + 0.0'].value).toBe('100000000000000000000');
  });

  it('one bad \\py{} expression does not lose the others', async () => {
    const v = await k.evals(['1 + 1', "__import__('sys').exit(0)", '2 + 2']);
    expect(v['1 + 1'].value).toBe('2');
    expect(v['2 + 2'].value).toBe('4');
    expect(v["__import__('sys').exit(0)"].ok).toBe(false);
  });

  it('the live preview never runs an expression with side effects', async () => {
    await k.run('lst = [1, 2, 3]');
    const v = await k.evals(['lst.pop()', 'len(lst)'], { pure: true });
    expect(v['lst.pop()'].skipped).toBe(true);
    expect(v['len(lst)'].value).toBe('3');
  });

  it('lint understands %%render cells and reports the real line', async () => {
    const found = await k.lint(['%%render\na = 2\nb = 3', '%%render\na = 2\nb = (']);
    expect(found.filter((f) => f.cell === 0)).toEqual([]);
    expect(found.find((f) => f.cell === 1).line).toBe(3);
  });

  it('a monkeypatched library makes the next reset ask for a new process', async () => {
    const clean = await k.run('', { reset: true });
    expect(clean.restart).toBeUndefined();
    await k.run('import math\nmath.pi = 3.0');
    const r = await k.run('', { reset: true });
    expect(r.restart).toEqual(['math.pi']);
  });
});
