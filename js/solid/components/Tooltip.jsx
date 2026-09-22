// Pyx tooltips — a drawn hover widget instead of the native Windows one.
//
// The native `title` tooltip is slow (~1 s), uses the system font, ignores the
// theme and looks like Windows 2000. VSCode draws its own; this is the same
// widget, with the numbers taken from VSCode 1.138 on this machine:
//
//   · delay 500 ms            — `workbench.hover.delay` default
//                               (out/vs/workbench/workbench.desktop.main.js)
//   · font-size 13, line 19   — `.workbench-hover`
//   · padding 4px 8px         — `.monaco-hover .hover-contents`
//   · radius 5px, 1px border  — `.workbench-hover`
//   · shadow 0 0 12px #0002   — `--vscode-shadow-lg`
//   · fade-in .1s linear      — `.monaco-hover.fade-in`
//   · key chips               — `.monaco-keybinding > .monaco-keybinding-key`
//
// The colours live in styles/tooltip.css.
//
// How it replaces `title`: on the first hover of an element the `title` is
// moved to `data-pyx-tip` (so Windows never gets to draw it) and mirrored to
// `aria-label` when the control has no visible text, or to `aria-description`
// when it has — the screen-reader name never gets worse than before. This
// catches every `title` in the app, including the ones set imperatively by the
// editor (notebook-cell buttons, log panel) which no component owns.

const TIP = 'data-pyx-tip';
const KEY = 'data-pyx-tip-key';
const DELAY = 500; // VSCode: workbench.hover.delay
const GAP = 4;     // distance from the anchor
const EDGE = 4;    // keep-inside-the-window margin

let host = null;
let textEl = null;
let keysEl = null;
let anchor = null;
let timer = 0;
let shown = false;
let watcher = null;

/* ---------- title -> data-pyx-tip (+ aria) ---------- */

/** Move an element's `title` into our own attribute, keeping accessibility. */
export function hoist(el) {
  if (!el || el.nodeType !== 1) return;
  const title = el.getAttribute('title');
  if (title === null) return;
  el.removeAttribute('title');
  const text = title.trim();
  if (!text) return;
  el.setAttribute(TIP, text);
  if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) return;
  // No visible text (icon-only button) -> the tip IS the accessible name.
  // Visible text -> keep that name and add the tip as the description.
  if (!(el.textContent || '').trim()) el.setAttribute('aria-label', text);
  else if (!el.hasAttribute('aria-description')) el.setAttribute('aria-description', text);
}

/** Props helper for new markup: `<button {...tip('Guardar', 'Ctrl+S')}>`. */
export function tip(text, combo) {
  const p = { [TIP]: text, 'aria-label': text };
  if (combo) p[KEY] = combo;
  return p;
}

/* ---------- the widget ---------- */

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.className = 'pyx-tip';
  host.setAttribute('role', 'tooltip');
  host.setAttribute('aria-hidden', 'true');
  textEl = document.createElement('span');
  textEl.className = 'pyx-tip-text';
  keysEl = document.createElement('span');
  keysEl.className = 'pyx-tip-keys';
  const row = document.createElement('div');
  row.className = 'pyx-tip-contents';
  row.append(textEl, keysEl);
  host.append(row);
  document.body.appendChild(host);
  return host;
}

// A shortcut written at the end of the label — "Nuevo documento (Ctrl+N)" —
// becomes key chips, the way VSCode shows the keybinding next to the title.
const PAREN_KEY = /\s*\(((?:Ctrl|Alt|Shift|Mayús|Cmd|Meta|Win)(?:\+[^()]{1,20})+|F\d{1,2}|Esc)\)/i;

function split(text) {
  // The shortcut becomes key chips, so it must not ALSO stay spelled out in
  // the sentence — several labels carry it mid-string ("… (Ctrl+Shift+B) ·
  // también al guardar"), which showed it twice in two different notations.
  const m = PAREN_KEY.exec(text);
  const label = m ? (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ').trim() : text;
  const explicit = anchor && anchor.getAttribute(KEY);
  return [label, explicit || (m ? m[1] : '')];
}

function render(raw) {
  const [label, combo] = split(raw);
  textEl.textContent = label;
  keysEl.textContent = '';
  if (!combo) { keysEl.hidden = true; return; }
  keysEl.hidden = false;
  for (const part of combo.split('+')) {
    const k = document.createElement('kbd');
    k.className = 'pyx-tip-key';
    k.textContent = part.trim();
    keysEl.appendChild(k);
  }
}

function place(el) {
  const r = el.getBoundingClientRect();
  const w = host.offsetWidth;
  const h = host.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = r.bottom + GAP;
  if (top + h > vh - EDGE) {
    const above = r.top - GAP - h;
    top = above >= EDGE ? above : Math.max(EDGE, vh - h - EDGE);
  }
  let left = Math.min(r.left, vw - w - EDGE);
  left = Math.max(EDGE, left);
  host.style.left = `${Math.round(left)}px`;
  host.style.top = `${Math.round(top)}px`;
}

function show(el) {
  const raw = (el.getAttribute(TIP) || '').trim();
  if (!raw || !el.isConnected || el.disabled) return;
  ensureHost();
  anchor = el;
  render(raw);
  host.style.visibility = 'hidden';
  host.classList.add('visible');
  place(el);
  host.style.visibility = '';
  host.classList.add('fade-in');
  host.setAttribute('aria-hidden', 'false');
  shown = true;
  // The label can change while the pointer stays put (Compilar -> Compilando…).
  watcher = new MutationObserver(() => {
    const now = (el.getAttribute(TIP) || el.getAttribute('title') || '').trim();
    if (!now) { hide(); return; }
    hoist(el);
    render(now);
    place(el);
  });
  watcher.observe(el, { attributes: true, attributeFilter: ['title', TIP, KEY] });
}

function hide() {
  clearTimeout(timer);
  timer = 0;
  anchor = null;
  if (watcher) { watcher.disconnect(); watcher = null; }
  if (!host || !shown) return;
  shown = false;
  host.classList.remove('visible', 'fade-in');
  host.setAttribute('aria-hidden', 'true');
}

function schedule(el) {
  clearTimeout(timer);
  timer = setTimeout(() => show(el), DELAY);
}

/* ---------- wiring ---------- */

const targetOf = (node) => (node && node.closest
  ? node.closest(`[title],[${TIP}]`)
  : null);

function onOver(e) {
  const el = targetOf(e.target);
  if (!el) { if (shown || timer) hide(); return; }
  hoist(el);
  if (!el.hasAttribute(TIP)) { hide(); return; }
  if (el === anchor && shown) return;
  hide();
  anchor = el;
  schedule(el);
}

function onOut(e) {
  if (!anchor) return;
  const to = e.relatedTarget;
  if (to && anchor.contains(to)) return;
  hide();
}

function onFocus(e) {
  const el = targetOf(e.target);
  if (!el) return;
  hoist(el);
  if (!el.hasAttribute(TIP)) return;
  // Only for keyboard focus: a click already shows what the button does.
  try { if (!el.matches(':focus-visible')) return; } catch (_) { return; }
  hide();
  anchor = el;
  schedule(el);
}

let installed = false;

/** Install the hover widget. Idempotent; called on import. */
export function initTooltips() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const start = () => {
    document.querySelectorAll('[title]').forEach(hoist);
    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerout', onOut, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    document.addEventListener('wheel', hide, { capture: true, passive: true });
    document.addEventListener('scroll', hide, { capture: true, passive: true });
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', hide, true);
    window.addEventListener('blur', hide);
    window.addEventListener('resize', hide);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

initTooltips();

export default initTooltips;
