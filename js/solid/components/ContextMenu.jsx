import { createSignal, For, Show } from 'solid-js';

// App-wide right-click menu, modelled on VSCode's: a hairline panel, a fixed
// icon column on the left so every label starts at the same x, the shortcut
// right-aligned, and section headings for groups that are not actions.
//
// Item shapes:
//   { label, icon?, shortcut?, danger?, disabled?, onClick }
//   { separator: true }
//   { header: 'Sugerencias' }        a small caption above a group
//   { …, suggestion: true }          a spelling correction: shown in the
//                                    editor's font and emphasised, so the
//                                    WORDS never read as one more command
//
// `icon` is an inline SVG string (js/solid/components/ribbon/icons.js).
const [menu, setMenu] = createSignal(null); // { x, y, items }

export function showContextMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  const pad = 6;
  // Rough box for edge clamping: headings and separators are shorter rows.
  const rows = items.reduce((n, it) => n + (it.separator ? 5 : it.header ? 20 : 26), 0);
  const w = 260;
  const x = Math.min(e.clientX, window.innerWidth - w - pad);
  const y = Math.min(e.clientY, window.innerHeight - (rows + 12) - pad);
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
            {(it) => {
              if (it.separator) return <div class="ctx-sep"></div>;
              if (it.header) return <div class="ctx-header">{it.header}</div>;
              return (
                <button
                  class={`ctx-item${it.danger ? ' danger' : ''}${it.suggestion ? ' suggestion' : ''}`}
                  disabled={it.disabled}
                  onClick={() => run(it)}
                >
                  <span class="ctx-icon" innerHTML={it.icon || ''}></span>
                  <span class="ctx-label">{it.label}</span>
                  <Show when={it.shortcut}><span class="ctx-shortcut">{it.shortcut}</span></Show>
                </button>
              );
            }}
          </For>
        </div>
      </div>
    </Show>
  );
}
