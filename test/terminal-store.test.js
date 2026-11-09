// @vitest-environment jsdom
// The in-app terminal's store (F8): output arrives in batches, the command
// runs with the kernel's interpreter, and it can be stopped.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ onLine: null, onDone: null, ran: [], stops: 0, stopAnswer: true }));

vi.mock('../js/core/platform.js', async (orig) => ({
  ...(await orig()),
  isTauri: () => true,
  runCommand: async (command, cwd, python) => { h.ran.push({ command, cwd, python }); },
  stopCommand: async () => { h.stops++; return h.stopAnswer; },
  onTerminalLine: async (cb) => { h.onLine = cb; return () => {}; },
  onTerminalDone: async (cb) => { h.onDone = cb; return () => {}; },
}));

const { state } = await import('../js/core/state.js');
const term = await import('../js/solid/stores/terminalStore.js');
const { general } = await import('../js/solid/stores/settingsStore.js');

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  if (term.termRunning() && h.onDone) h.onDone(0);
  vi.runOnlyPendingTimers();
  term.clearTerminal();
  vi.useRealTimers();
  h.ran.length = 0; h.stops = 0; h.stopAnswer = true;
});

describe('terminal store', () => {
  it('runs pip/python with the interpreter the kernel uses', async () => {
    state.env = { ...state.env, python: 'C:\\envs\\obra\\python.exe' };
    await term.runTerminal('pip install numpy', 'C:\\p');
    expect(h.ran).toEqual([{ command: 'pip install numpy', cwd: 'C:\\p', python: 'C:\\envs\\obra\\python.exe' }]);
    expect(term.termRunning()).toBe(true);
    expect(term.termLines().map((l) => l.text)).toEqual(['> pip install numpy']);
    // A second command is not started while one runs.
    await term.runTerminal('pip list', 'C:\\p');
    expect(h.ran).toHaveLength(1);
    // The interpreter chosen in Configuración wins over the detected one.
    h.onDone(0);
    general.pythonPath = 'D:\\elegido\\python.exe';
    try {
      await term.runTerminal('pip list', 'C:\\p');
      expect(h.ran[1].python).toBe('D:\\elegido\\python.exe');
    } finally {
      general.pythonPath = '';
    }
  });

  it('publishes a burst of output once, not once per line, and caps the scrollback', async () => {
    await term.runTerminal('dir /s', null);
    let updates = 0;
    const seen = new Set();
    const count = () => { const l = term.termLines(); if (!seen.has(l)) { seen.add(l); updates++; } };
    count();
    for (let i = 0; i < 5000; i++) { h.onLine(`línea ${i}`); count(); }
    // Nothing published while the burst arrives…
    expect(updates).toBe(1);
    vi.advanceTimersByTime(60);
    count();
    // …then all of it at once, capped to the last 2000 lines.
    expect(updates).toBe(2);
    const lines = term.termLines();
    expect(lines).toHaveLength(2000);
    expect(lines[lines.length - 1].text).toBe('línea 4999');
    expect(lines[0].text).toBe('línea 3000');
    // A few more lines: appended, the old entries are the same objects (the
    // list only has to add rows, not redraw them).
    const firstKept = lines[5];
    h.onLine('una más');
    vi.advanceTimersByTime(60);
    expect(term.termLines()[4]).toBe(firstKept);
    expect(term.termLines().at(-1).text).toBe('una más');
  });

  it('reports the end of the command and frees the panel', async () => {
    await term.runTerminal('python --version', null);
    h.onLine('Python 3.12.1');
    h.onDone(0);
    expect(term.termRunning()).toBe(false);
    expect(term.termLines().map((l) => l.text)).toEqual(['> python --version', 'Python 3.12.1', '✓ Listo (código 0)']);
  });

  it('can be stopped; the end is then reported as a stop, not as a failure', async () => {
    await term.runTerminal('python bucle.py', null);
    await term.stopTerminal();
    expect(h.stops).toBe(1);
    expect(term.termRunning()).toBe(true); // until the process is really gone
    h.onDone(1);
    expect(term.termRunning()).toBe(false);
    expect(term.termLines().at(-1).text).toBe('■ Detenido');
    // The next command reports normally again.
    await term.runTerminal('python ok.py', null);
    h.onDone(3);
    expect(term.termLines().at(-1).text).toBe('✗ Terminado con código 3');
  });

  it('a stop with nothing running on the other side frees the panel too', async () => {
    await term.runTerminal('algo', null);
    h.stopAnswer = false; // the backend has no process (its «done» was lost)
    await term.stopTerminal();
    expect(term.termRunning()).toBe(false);
  });
});
