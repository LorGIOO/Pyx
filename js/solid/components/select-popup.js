// Every <select> of the app opens Pyx's own list instead of the browser's.
//
// The closed control is already drawn by Pyx (styles/controls.css); its open
// list was the operating system's — a plain white box with the system font,
// the one thing in a dialog that looked like a web page. This replaces it for
// every <select>, wherever it is and whoever made it, without touching any
// component: the native element stays (value, onChange, form semantics,
// keyboard arrows on the closed control) and only its popup is ours.
//
// Picking an item sets the select's value and fires `input` and `change`
// exactly as the native list does, so Solid's handlers run unchanged.

let menu = null; // { el, select, items, active }

function close(focus = true) {
  if (!menu) return;
  const { el, select } = menu;
  menu = null;
  el.remove();
  select.classList.remove('pyx-select-open');
  if (focus) select.focus({ preventScroll: true });
}

function pick(i) {
  if (!menu) return;
  const { select, items } = menu;
  const it = items[i];
  if (!it || it.disabled) return;
  close();
  if (select.selectedIndex !== it.index) {
    select.selectedIndex = it.index;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function setActive(i) {
  if (!menu) return;
  const n = menu.items.length;
  if (!n) return;
  // Skip disabled items in the direction of travel.
  const dir = i >= menu.active ? 1 : -1;
  let k = Math.max(0, Math.min(n - 1, i));
  while (menu.items[k] && menu.items[k].disabled) k += dir;
  if (!menu.items[k]) return;
  menu.active = k;
  menu.el.querySelectorAll('.pyx-select-item').forEach((b, j) => b.classList.toggle('active', j === k));
  const b = menu.el.querySelectorAll('.pyx-select-item')[k];
  if (b) b.scrollIntoView({ block: 'nearest' });
}

function open(select) {
  close(false);
  const el = document.createElement('div');
  el.className = 'pyx-select-menu ribbon-dd-menu';
  el.setAttribute('role', 'listbox');
  const items = [];
  const add = (opt, inGroup) => {
    if (opt.hidden) return;
    const b = document.createElement('div');
    b.className = 'pyx-select-item' + (inGroup ? ' in-group' : '') + (opt.disabled ? ' disabled' : '') + (opt.selected ? ' selected' : '');
    b.setAttribute('role', 'option');
    b.textContent = opt.textContent;
    if (opt.style && opt.style.fontFamily) b.style.fontFamily = opt.style.fontFamily; // font pickers
    const i = items.length;
    items.push({ index: opt.index, disabled: opt.disabled });
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => pick(i));
    b.addEventListener('mousemove', () => { if (menu && menu.active !== i && !opt.disabled) setActive(i); });
    el.appendChild(b);
  };
  for (const child of select.children) {
    if (child.tagName === 'OPTGROUP') {
      const h = document.createElement('div');
      h.className = 'pyx-select-group';
      h.textContent = child.label;
      el.appendChild(h);
      for (const o of child.children) if (o.tagName === 'OPTION') add(o, true);
    } else if (child.tagName === 'OPTION') add(child, false);
  }
  if (!items.length) return;
  document.body.appendChild(el);
  select.classList.add('pyx-select-open');
  menu = { el, select, items, active: -1 };

  // Under the control, as wide as it at least; above it when there is no room.
  const r = select.getBoundingClientRect();
  el.style.minWidth = `${Math.round(r.width)}px`;
  el.style.left = `${Math.round(r.left)}px`;
  const h = el.offsetHeight;
  const below = innerHeight - r.bottom - 8;
  const above = r.top - 8;
  if (h <= below || below >= above) {
    el.style.top = `${Math.round(r.bottom + 2)}px`;
    el.style.maxHeight = `${Math.max(120, below)}px`;
  } else {
    el.style.top = `${Math.round(Math.max(8, r.top - 2 - Math.min(h, above)))}px`;
    el.style.maxHeight = `${Math.max(120, above)}px`;
  }
  const w = el.offsetWidth;
  if (r.left + w > innerWidth - 8) el.style.left = `${Math.max(8, innerWidth - 8 - w)}px`;
  const cur = items.findIndex((it) => it.index === select.selectedIndex);
  setActive(cur >= 0 ? cur : 0);
}

function isOurs(select) {
  return select && select.tagName === 'SELECT' && !select.multiple && !(select.size > 1) && !select.disabled
    && !select.closest('[data-native-select]');
}

export function installSelectPopup() {
  if (typeof document === 'undefined' || installSelectPopup.done) return;
  installSelectPopup.done = true;

  // Mouse: the native list opens on mousedown — ours instead.
  document.addEventListener('mousedown', (e) => {
    if (menu && menu.el.contains(e.target)) return;
    const s = e.target.closest && e.target.closest('select');
    if (isOurs(s) && e.button === 0) {
      e.preventDefault();
      if (menu && menu.select === s) { close(); return; }
      s.focus({ preventScroll: true });
      open(s);
      return;
    }
    if (menu) close(false);
  }, true);

  // Keyboard: Space / Enter / Alt+↓ / F4 open it; in it, arrows, Home/End,
  // Enter and Escape, and typing a letter jumps to an item.
  document.addEventListener('keydown', (e) => {
    if (menu) {
      const k = e.key;
      if (k === 'Escape' || k === 'Tab') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (k === 'ArrowDown') { e.preventDefault(); setActive(menu.active + 1); return; }
      if (k === 'ArrowUp') { e.preventDefault(); setActive(menu.active - 1); return; }
      if (k === 'Home') { e.preventDefault(); setActive(0); return; }
      if (k === 'End') { e.preventDefault(); setActive(menu.items.length - 1); return; }
      if (k === 'PageDown') { e.preventDefault(); setActive(menu.active + 8); return; }
      if (k === 'PageUp') { e.preventDefault(); setActive(menu.active - 8); return; }
      if (k === 'Enter' || k === ' ') { e.preventDefault(); e.stopPropagation(); pick(menu.active); return; }
      if (k.length === 1 && !e.ctrlKey && !e.metaKey) {
        const els = [...menu.el.querySelectorAll('.pyx-select-item')];
        const low = k.toLowerCase();
        const from = menu.active + 1;
        const order = [...els.keys()].map((j) => (from + j) % els.length);
        const hit = order.find((j) => els[j].textContent.trim().toLowerCase().startsWith(low));
        if (hit !== undefined) { e.preventDefault(); setActive(hit); }
      }
      return;
    }
    const s = e.target;
    if (!isOurs(s)) return;
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'F4' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) {
      e.preventDefault();
      open(s);
    }
  }, true);

  // Anything that moves the control away closes the list.
  addEventListener('resize', () => close(false));
  document.addEventListener('scroll', (e) => {
    if (menu && !menu.el.contains(e.target)) close(false);
  }, true);
  addEventListener('blur', () => close(false));
}
