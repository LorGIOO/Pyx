// A popup anchored under a control: open/close state, click-outside, Escape
// and a position that never leaves the window.
//
// The ribbon dropdowns, the popover of a collapsed ribbon group and the PDF
// toolbar's "…" menu all need exactly this, and the first of them used to
// carry its own copy — one that placed the menu at the control's left edge and
// stopped there, so a dropdown near the right border of a narrow window opened
// half off-screen.
//
// The popup is expected to be `position: fixed` and to live anywhere in the
// DOM (a fixed box escapes `overflow: hidden`, as long as no ancestor has a
// transform — see .ribbon-popover in ribbon.css).

import { createSignal, onCleanup } from 'solid-js';

const EDGE = 4; // keep-inside-the-window margin, same as the tooltips
const GAP = 1;  // distance from the anchor

// Open popups, oldest first. A dropdown opened INSIDE a group popover is a
// second entry: Escape must close only the one on top.
const stack = [];

/**
 * Where a popup of `size` goes for an `anchor` rect, kept inside `viewport`.
 * Below the anchor and left-aligned with it when that fits; shifted left when
 * it would cross the right edge; above the anchor when there is no room
 * below; and, when neither side is tall enough, on the roomier side with a
 * `maxHeight` so it scrolls instead of being cut off.
 *
 * Pure: every rect is passed in ({left, right, top, bottom}, {width, height}).
 */
export function placePopup(anchor, size, viewport, opts = {}) {
  const edge = opts.edge ?? EDGE;
  const gap = opts.gap ?? GAP;
  let left = opts.align === 'end' ? anchor.right - size.width : anchor.left;
  left = Math.min(left, viewport.width - size.width - edge);
  left = Math.max(edge, left);

  let top = anchor.bottom + gap;
  let maxHeight = null;
  if (top + size.height > viewport.height - edge) {
    const roomBelow = viewport.height - edge - top;
    const roomAbove = anchor.top - gap - edge;
    if (size.height <= roomAbove) {
      top = anchor.top - gap - size.height;
    } else if (roomBelow >= roomAbove) {
      maxHeight = Math.max(0, roomBelow);
    } else {
      top = edge;
      maxHeight = Math.max(0, roomAbove);
    }
  }
  return { left: Math.round(left), top: Math.round(top), maxHeight };
}

/**
 * Hook. Returns:
 *   open()            is it showing
 *   show/close/toggle
 *   anchor(el)        ref for the control it hangs from
 *   popup(el)         ref for the popup element itself
 *   style()           inline style for the popup (left/top/max-height, and
 *                     hidden for the one frame it takes to measure it)
 *
 * opts.align   'start' (default) | 'end' — which edge of the anchor it lines up with
 * opts.onOpen  called right after it opens (before it is measured)
 * opts.onClose called right after it closes
 */
export function createAnchoredPopup(opts = {}) {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal(null); // null until measured
  let anchorEl = null;
  let popupEl = null;
  let raf = 0;
  const self = {};

  const inside = (node) => !!node
    && ((anchorEl && anchorEl.contains(node)) || (popupEl && popupEl.contains(node)));

  // Capture phase: a click that lands on something which stops propagation
  // (the editor does) must still close the popup.
  const onDocDown = (e) => { if (!inside(e.target)) close(); };
  const onKey = (e) => {
    if (e.key !== 'Escape' || stack[stack.length - 1] !== self) return;
    // Stopped here so the same Escape does not also leave zen mode or cancel
    // a selection in the editor underneath.
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  };
  // The anchor moves when the window is resized; a menu left behind pointing
  // at nothing is worse than a closed one.
  const onResize = () => close();

  function place() {
    raf = 0;
    if (!open() || !anchorEl || !popupEl || !popupEl.isConnected) return;
    // This is its natural size: show() cleared the position, and with it any
    // max-height left over from a previous opening.
    const r = popupEl.getBoundingClientRect();
    setPos(placePopup(
      anchorEl.getBoundingClientRect(),
      { width: r.width, height: r.height },
      { width: window.innerWidth, height: window.innerHeight },
      { align: opts.align },
    ));
  }

  function show() {
    if (open() || !anchorEl) return;
    setPos(null);
    setOpen(true);
    stack.push(self);
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    if (opts.onOpen) opts.onOpen();
    // Its real size only exists once it is in the DOM. Usually that is right
    // now (Solid renders synchronously); if not, one frame later.
    if (popupEl && popupEl.isConnected) place();
    else raf = requestAnimationFrame(place);
  }

  function close() {
    if (!open()) return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    setOpen(false);
    const i = stack.indexOf(self);
    if (i >= 0) stack.splice(i, 1);
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    if (opts.onClose) opts.onClose();
  }

  onCleanup(close);

  return {
    open,
    show,
    close,
    toggle: () => (open() ? close() : show()),
    anchor: (el) => { anchorEl = el; },
    popup: (el) => { popupEl = el; if (open() && !raf) raf = requestAnimationFrame(place); },
    style: () => {
      const p = pos();
      if (!p) return { left: '0px', top: '0px', visibility: 'hidden' };
      return {
        left: `${p.left}px`,
        top: `${p.top}px`,
        'max-height': p.maxHeight == null ? undefined : `${p.maxHeight}px`,
        visibility: 'visible',
      };
    },
  };
}
