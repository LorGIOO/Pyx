import { createSignal, For, Show } from 'solid-js';

// App-wide professional context menu (VSCode-like), replacing the browser one.
// Usage: showContextMenu(e, [{ label, shortcut?, danger?, disabled?, onClick }, { separator: true }, …])
const [menu, setMenu] = createSignal(null); // { x, y, items }

export function showContextMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  const pad = 6;
  const w = 240, h = items.length * 26 + 12; // rough box for edge clamping
  const x = Math.min(e.clientX, window.innerWidth - w - pad);
  const y = Math.min(e.clientY, window.innerHeight - h - pad);
  setMenu({ x: Math.max(pad, x), y: Math.max(pad, y), items });
}

export function hideContextMenu() {
  setMenu(null);
}

export default function ContextMenu() {
  const run = (it) => {
    if (it.disabled) return;
    hideContextMenu();
    it.onClick && it.onClick();
  };
  return (
    <Show when={menu()}>
      <div class="ctx-overlay"
        onMouseDown={(e) => { if (e.target === e.currentTarget) hideContextMenu(); }}
        onContextMenu={(e) => { e.preventDefault(); hideContextMenu(); }}>
        <div class="ctx-menu" style={{ left: menu().x + 'px', top: menu().y + 'px' }}>
          <For each={menu().items}>
            {(it) => it.separator
              ? <div class="ctx-sep"></div>
              : (
                <button
                  class={`ctx-item${it.danger ? ' danger' : ''}`}
                  disabled={it.disabled}
                  onClick={() => run(it)}
                >
                  <span class="ctx-label">{it.label}</span>
                  <Show when={it.shortcut}><span class="ctx-shortcut">{it.shortcut}</span></Show>
                </button>
              )}
          </For>
        </div>
      </div>
    </Show>
  );
}
