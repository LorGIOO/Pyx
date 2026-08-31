// In-app terminal: runs shell commands (mainly `pip install ...`) in the Rust
// backend and streams their output here via Tauri events. `pip`/`python` are
// routed to the same interpreter the Python kernel uses, so anything installed
// is immediately importable from the cells.

import { createSignal } from 'solid-js';
import { runCommand, onTerminalLine, onTerminalDone, isTauri } from '../../core/platform.js';

export const [termLines, setTermLines] = createSignal([]); // [{ kind, text }]
export const [termRunning, setTermRunning] = createSignal(false);

const history = [];
export function pushHistory(cmd) {
  if (cmd && history[history.length - 1] !== cmd) history.push(cmd);
}
export function getHistory() { return history; }

function append(kind, text) {
  setTermLines((prev) => {
    const next = prev.concat({ kind, text });
    return next.length > 2000 ? next.slice(next.length - 2000) : next; // cap scrollback
  });
}

let listenersReady = false;
async function ensureListeners() {
  if (listenersReady || !isTauri()) return;
  listenersReady = true;
  await onTerminalLine((line) => append('out', String(line)));
  await onTerminalDone((code) => {
    append('sys', code === 0 ? '✓ Listo (código 0)' : `✗ Terminado con código ${code}`);
    setTermRunning(false);
  });
}

export async function runTerminal(command, cwd) {
  const cmd = (command || '').trim();
  if (!cmd || termRunning()) return;
  await ensureListeners();
  append('cmd', '> ' + cmd);
  setTermRunning(true);
  try {
    await runCommand(cmd, cwd);
  } catch (e) {
    append('sys', String((e && e.message) || e));
    setTermRunning(false);
  }
}

export function clearTerminal() { setTermLines([]); }
