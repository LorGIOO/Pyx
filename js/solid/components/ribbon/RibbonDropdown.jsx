import { createSignal, For, Show } from 'solid-js';
import { t } from '../../../core/i18n.js';
import { createAnchoredPopup } from '../createAnchoredPopup.js';

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
// position:fixed so it escapes the ribbon's clipping; opening, closing and
// keeping it inside the window is createAnchoredPopup's job.
export default function RibbonDropdown(props) {
  const key = () => props.memKey || props.label || props.caption;
  const menu = createAnchoredPopup();
  const open = menu.open;
  const close = menu.close;
  const toggle = menu.toggle;
  const findRemembered = () => {
    const lbl = MEM[key()];
    return lbl ? (props.items || []).find((it) => it.label === lbl) || null : null;
  };
  const [last, setLast] = createSignal(findRemembered());

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
    if (props.caption) return c ? c.label : (props.placeholder || t('Elegir…', 'Choose…'));
    return c ? c.label : props.label;
  };
  const mainSym = () => (cur() && !props.compact ? cur().sym : null);
  const mainBadge = () => (cur() && !props.compact && !cur().sym ? cur().badge : null);
  // The dropdown's own icon (`icon` prop) stands in until a pick brings its
  // symbol or badge: it says what the control is while it still reads
  // "Elegir…". It was accepted and silently dropped before.
  const mainIcon = () => (props.icon && !props.compact && !mainSym() && !mainBadge() ? props.icon : null);
  const baseTitle = () => props.title || props.label || props.caption;
  const mainTitle = () => (cur()
    ? `${baseTitle()} — ${t('última', 'last')}: ${cur().label} ${t('(clic para repetir, ▾ para cambiar)', '(click to repeat, ▾ to change)')}`
    : baseTitle());

  const control = (
    <div
      class={`ribbon-dd${props.compact ? ' compact' : ''}${props.caption ? ' captioned' : ''}${open() ? ' open' : ''}`}
      ref={menu.anchor}
    >
      <button class="ribbon-dd-main" title={mainTitle()} onClick={onMain}>
        <Show when={mainIcon()}>
          <span class="dd-main-ico pyx-ico" innerHTML={mainIcon()}></span>
        </Show>
        <Show when={mainSym()}>
          <span class="dd-main-sym" innerHTML={mainSym()}></span>
        </Show>
        <Show when={mainBadge()}>
          <span class="dd-item-badge" style={cur().badgeStyle}>{mainBadge()}</span>
        </Show>
        <span class="ribbon-dd-label" classList={{ placeholder: !!props.caption && !cur() }}>{mainLabel()}</span>
      </button>
      <button class="ribbon-dd-caret" title={t('Más opciones', 'More options')} onClick={toggle}>▾</button>
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
        <div class="ribbon-dd-menu" ref={menu.popup} style={menu.style()}>
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
