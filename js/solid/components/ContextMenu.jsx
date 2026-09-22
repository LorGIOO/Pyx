import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js';

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
const [menu, setMenu] = createSignal(null);   // { x, y, items } — where the click was
const [placed, setPlaced] = createSignal(null); // { x, y } — where it actually fits

export function showContextMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  // The click point is all we know here. Fitting it to the screen needs the
  // menu's REAL size, which only exists once it is in the DOM — see `place`.
  setPlaced(null);
  setMenu({ x: e.clientX, y: e.clientY, items });
}

export function hideContextMenu() {
  setMenu(null);
  setPlaced(null);
}

const PAD = 6;

export default function ContextMenu() {
  const run = (it) => {
    if (it.disabled) return;
    hideContextMenu();
    it.onClick && it.onClick();
  };

  // Escape closes it, like every native menu. Capture phase and stopped, so the
  // key never reaches the editor underneath and cancels a selection as well.
  createEffect(() => {
    if (!menu()) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      hideContextMenu();
    };
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => window.removeEventListener('keydown', onKey, true));
  });

  // Fit the menu to the window using its measured box, not a guess. The old
  // code added up an assumed 26px per row, which was wrong for every menu with
  // a heading or a separator and wronger still for the spelling menu, whose
  // length depends on how many suggestions the dictionary returns: near the
  // bottom of the screen the last items ended up off-screen. Flip horizontally
  // (native behaviour) and clamp vertically (VSCode's).
  const place = (el) => {
    requestAnimationFrame(() => {
      const m = menu();
      if (!m || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      let x = m.x;
      let y = m.y;
      if (x + r.width > window.innerWidth - PAD) x = m.x - r.width;
      if (y + r.height > window.innerHeight - PAD) y = window.innerHeight - r.height - PAD;
      setPlaced({ x: Math.max(PAD, x), y: Math.max(PAD, y) });
    });
  };

  return (
    <Show when={menu()}>
      <div class="ctx-overlay"
        onMouseDown={(e) => { if (e.target === e.currentTarget) hideContextMenu(); }}
        onContextMenu={(e) => { e.preventDefault(); hideContextMenu(); }}>
        {/* Hidden for the one frame it takes to measure it, so it never blinks
            at the wrong place before landing. */}
        <div class="ctx-menu" ref={place}
          style={{
            left: `${(placed() || menu()).x}px`,
            top: `${(placed() || menu()).y}px`,
            visibility: placed() ? 'visible' : 'hidden',
          }}>
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
