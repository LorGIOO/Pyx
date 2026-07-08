import { createEffect, For, Show } from 'solid-js';
import { state, activeDoc } from '../../core/state.js';
import {
  termLines, termRunning, runTerminal, clearTerminal, pushHistory, getHistory,
} from '../stores/terminalStore.js';
import { dirOf } from '../../core/paths.js';

export default function TerminalPanel() {
  let scrollRef, inputRef;
  let histIdx = -1;

  // Auto-scroll to the bottom as new output streams in.
  createEffect(() => {
    termLines();
    if (scrollRef) requestAnimationFrame(() => { scrollRef.scrollTop = scrollRef.scrollHeight; });
  });

  const submit = () => {
    const v = inputRef.value.trim();
    if (!v || termRunning()) return;
    pushHistory(v);
    histIdx = -1;
    runTerminal(v, dirOf(activeDoc()?.path));
    inputRef.value = '';
  };

  const onKey = (e) => {
    const h = getHistory();
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'ArrowUp') {
      if (!h.length) return;
      histIdx = histIdx < 0 ? h.length - 1 : Math.max(0, histIdx - 1);
      inputRef.value = h[histIdx];
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      if (histIdx < 0) return;
      histIdx += 1;
      if (histIdx >= h.length) { histIdx = -1; inputRef.value = ''; }
      else inputRef.value = h[histIdx];
      e.preventDefault();
    }
  };

  return (
    <div class="terminal-panel">
      <div class="terminal-header">
        <span>Terminal{termRunning() ? ' · ejecutando…' : ''}</span>
        <div class="terminal-header-actions">
          <button onClick={clearTerminal} title="Limpiar la salida">Limpiar</button>
          <button onClick={() => (state.terminalVisible = false)} title="Cerrar">×</button>
        </div>
      </div>
      <div class="terminal-body" ref={scrollRef}>
        <For each={termLines()}>{(l) => <div class={`term-line ${l.kind}`}>{l.text}</div>}</For>
        <Show when={termLines().length === 0}>
          <div class="term-hint">
            Escribe un comando y pulsa Enter. Por ejemplo:{' '}
            <b>pip install numpy</b> · <b>pip list</b> · <b>python --version</b>.<br />
            <code>pip</code> y <code>python</code> usan el mismo intérprete que las celdas.
          </div>
        </Show>
      </div>
      <div class="terminal-input-row">
        <span class="terminal-prompt">$</span>
        <input
          ref={inputRef}
          type="text"
          class="terminal-input"
          placeholder="pip install ..."
          onKeyDown={onKey}
          disabled={termRunning()}
          spellcheck={false}
          autocomplete="off"
        />
      </div>
    </div>
  );
}
