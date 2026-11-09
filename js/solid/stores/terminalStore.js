// In-app terminal: runs shell commands (mainly `pip install ...`) in the Rust
// backend and streams their output here via Tauri events. `pip`/`python` are
// routed to the same interpreter the Python kernel uses, so anything installed
// is immediately importable from the cells.

import { createSignal } from 'solid-js';
import {
  runCommand, stopCommand, onTerminalLine, onTerminalDone, isTauri,
} from '../../core/platform.js';
import { state } from '../../core/state.js';
import { general } from './settingsStore.js';

export const [termLines, setTermLines] = createSignal([]); // [{ kind, text }]
export const [termRunning, setTermRunning] = createSignal(false);

const history = [];
export function pushHistory(cmd) {
  if (cmd && history[history.length - 1] !== cmd) history.push(cmd);
}
export function getHistory() { return history; }

/* Output is collected and published in batches.
 *
 * Every line used to copy the whole scrollback (`prev.concat(line)`, up to
 * 2000 entries) and hand the new array to the list, which diffs it against
 * the old one: a `pip install` or a `dir /s` printing thousands of lines did
 * that thousands of times — quadratic work on the UI thread, exactly while
 * the user is waiting for the command. Lines now wait in a buffer and go out
 * together a few times per second: one copy per batch, not per line. */
const MAX_LINES = 2000; // scrollback cap
const FLUSH_MS = 50;
let pending = [];
let flushTimer = 0;

export function flushTerminal() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  setTermLines((prev) => {
    // A burst larger than the scrollback: only its tail can ever be seen.
    if (batch.length >= MAX_LINES) return batch.slice(batch.length - MAX_LINES);
    const next = prev.concat(batch);
    return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
  });
}

function append(kind, text) {
  pending.push({ kind, text });
  // A runaway command must not grow the buffer without bound between flushes.
  if (pending.length > MAX_LINES * 2) pending = pending.slice(pending.length - MAX_LINES);
  if (!flushTimer) flushTimer = setTimeout(flushTerminal, FLUSH_MS);
}

let listenersReady = false;
let stopRequested = false;
async function ensureListeners() {
  if (listenersReady || !isTauri()) return;
  listenersReady = true;
  await onTerminalLine((line) => append('out', String(line)));
  await onTerminalDone((code) => {
    append('sys', stopRequested
      ? '■ Detenido'
      : (code === 0 ? '✓ Listo (código 0)' : `✗ Terminado con código ${code}`));
    stopRequested = false;
    setTermRunning(false);
    flushTerminal();
  });
}

export async function runTerminal(command, cwd) {
  const cmd = (command || '').trim();
  if (!cmd || termRunning()) return;
  await ensureListeners();
  append('cmd', '> ' + cmd);
  flushTerminal();
  stopRequested = false;
  setTermRunning(true);
  try {
    // The interpreter the kernel runs: the one chosen in Configuración if
    // there is one (the kernel's own rule), else the one in use.
    const python = general.pythonPath || (state.env && state.env.python) || null;
    await runCommand(cmd, cwd, python);
  } catch (e) {
    append('sys', String((e && e.message) || e));
    setTermRunning(false);
    flushTerminal();
  }
}

/** Stop the running command (a `pip install` that hangs, a script in a loop).
 *  There was no way to: the input stays disabled while a command runs, so one
 *  that never ended took the terminal with it until Pyx was restarted. */
export async function stopTerminal() {
  if (!termRunning()) return;
  stopRequested = true;
  try {
    const stopped = await stopCommand();
    // Nothing was running on the other side (its «done» was lost): free the panel.
    if (!stopped) { stopRequested = false; setTermRunning(false); }
  } catch (e) {
    stopRequested = false;
    append('sys', String((e && e.message) || e));
  }
}

export function clearTerminal() {
  pending = [];
  setTermLines([]);
}
