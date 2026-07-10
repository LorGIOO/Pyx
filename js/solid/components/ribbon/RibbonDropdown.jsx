import { createSignal, onCleanup, For, Show } from 'solid-js';

// Remembered last pick per dropdown (by memKey), persisted across sessions.
const MEM = (() => {
  try { return JSON.parse(localStorage.getItem('pyx-dd-mem') || '{}'); } catch (_) { return {}; }
})();
function remember(key, label) {
  MEM[key] = label;
  try { localStorage.setItem('pyx-dd-mem', JSON.stringify(MEM)); } catch (_) { /* ignore */ }
}

// A split-button ribbon dropdown (TeXstudio-style toolbar combo):
//   • the MAIN part shows the last-used option and re-applies it on click
//     (no menu) — "memory", so a repeated insert is one click;
//   • the CARET opens the full menu to pick a different option.
// Each menu item shows a leading symbol/badge that represents it. The menu is
// position:fixed so it escapes the ribbon's clipping.
export default function RibbonDropdown(props) {
  const key = () => props.memKey || props.label || props.caption;
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ left: 0, top: 0 });
  const findRemembered = () => {
    const lbl = MEM[key()];
    return lbl ? (props.items || []).find((it) => it.label === lbl) || null : null;
  };
  const [last, setLast] = createSignal(findRemembered());
  let wrapEl;

  const onDocDown = (e) => {
    if (wrapEl && wrapEl.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.ribbon-dd-menu')) return;
    close();
  };
  function close() {
    setOpen(false);
    document.removeEventListener('mousedown', onDocDown, true);
  }
  function toggle() {
    if (open()) { close(); return; }
    const r = wrapEl.getBoundingClientRect();
    setPos({ left: r.left, top: r.bottom + 1 });
    setOpen(true);
    document.addEventListener('mousedown', onDocDown, true);
  }
  onCleanup(() => document.removeEventListener('mousedown', onDocDown, true));

  const apply = (it) => { props.onPick && props.onPick(it); };
  // Pick from the menu → remember + apply.
  const pickFromMenu = (it) => {
    close();
    setLast(it);
    remember(key(), it.label);
    apply(it);
  };
  // Click the main button → repeat the last pick; if none yet, open the menu.
  const onMain = () => {
    const l = last();
    if (l) apply(l);
    else toggle();
  };

  const cur = () => last();
  // Compact dropdowns (delimiters, Aa, Listas) live in tight icon rows, so the
  // main button shows just the short token. Captioned dropdowns (Office-style)
  // carry the NAME outside, so the control shows the chosen value — or a muted
  // placeholder until the first pick. Plain dropdowns show the name until used.
  const mainLabel = () => {
    const c = cur();
    if (props.compact) return c ? (c.sym || c.badge || c.label) : (props.label || props.caption);
    if (props.caption) return c ? c.label : (props.placeholder || 'Choose…');
    return c ? c.label : props.label;
  };
  const mainSym = () => (cur() && !props.compact ? cur().sym : null);
  const mainBadge = () => (cur() && !props.compact && !cur().sym ? cur().badge : null);
  const baseTitle = () => props.title || props.label || props.caption;
  const mainTitle = () => (cur()
    ? `${baseTitle()} — last: ${cur().label} (click to repeat, ▾ to change)`
    : baseTitle());

  const control = (
    <div
      class={`ribbon-dd${props.compact ? ' compact' : ''}${props.caption ? ' captioned' : ''}${open() ? ' open' : ''}`}
      ref={wrapEl}
    >
      <button class="ribbon-dd-main" title={mainTitle()} onClick={onMain}>
        <Show when={mainSym()}>
          <span class="dd-main-sym" innerHTML={mainSym()}></span>
        </Show>
        <Show when={mainBadge()}>
          <span class="dd-item-badge" style={cur().badgeStyle}>{mainBadge()}</span>
        </Show>
        <span class="ribbon-dd-label" classList={{ placeholder: !!props.caption && !cur() }}>{mainLabel()}</span>
      </button>
      <button class="ribbon-dd-caret" title="Más opciones" onClick={toggle}>▾</button>
    </div>
  );

  return (
    <>
      {props.caption
        ? (
          <div class="ribbon-dd-field">
            <span class="ribbon-dd-cap">{props.caption}</span>
            {control}
          </div>
        )
        : control}
      <Show when={open()}>
        <div class="ribbon-dd-menu" style={{ left: pos().left + 'px', top: pos().top + 'px' }}>
          <For each={props.items}>
            {(it) => (
              <button class="ribbon-dd-item" onClick={() => pickFromMenu(it)}>
                <Show when={it.sym}>
                  <span class="dd-item-sym" innerHTML={it.sym}></span>
                </Show>
                <Show when={it.badge && !it.sym}>
                  <span class="dd-item-badge" style={it.badgeStyle}>{it.badge}</span>
                </Show>
                <span class="dd-item-label" innerHTML={it.html || it.label}></span>
                <Show when={it.hint}><span class="dd-item-hint">{it.hint}</span></Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}
