// The other people's carets and selections inside the editor, in their color
// with their name (shown while they type, and on hover). Positions are Yjs
// relative positions, so a caret stays on its character while text before it
// changes. Rebuilt only when someone moves or the text changes — never on
// mouse movement (pointers are a separate overlay, pointer-layer.js).

import { ViewPlugin, Decoration, WidgetType, EditorView } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import { docIdOf } from '../editor/doc-id.js';
import { others, onSelectionChange } from './presence-store.js';
import { indexFromRel, boundPath } from './ybridge.js';

export const caretsRefresh = StateEffect.define();

class CaretWidget extends WidgetType {
  // `at` = when that person last moved: a move rebuilds the widget, which
  // replays the name tag's fade (shown while they type, then gone).
  constructor(name, color, at) { super(); this.name = name; this.color = color; this.at = at; }
  eq(o) { return o.name === this.name && o.color === this.color && o.at === this.at; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'pyx-rcaret';
    el.style.setProperty('--c', this.color);
    const flag = document.createElement('span');
    flag.className = 'pyx-rcaret-flag';
    flag.textContent = this.name; // text, never HTML: names come from other people
    el.appendChild(flag);
    return el;
  }
  ignoreEvent() { return true; }
}

function build(view) {
  const docId = docIdOf(view.state);
  const path = boundPath(docId);
  if (!path) return Decoration.none;
  const len = view.state.doc.length;
  const marks = [];
  for (const p of others()) {
    const s = p.state;
    if (!s || s.f !== path || !s.s) continue;
    const a = indexFromRel(docId, s.s[0]);
    const h = indexFromRel(docId, s.s[1]);
    if (a == null || h == null || a > len || h > len) continue;
    const from = Math.min(a, h), to = Math.max(a, h);
    if (to > from) {
      marks.push(Decoration.mark({
        class: 'pyx-rsel',
        attributes: { style: `--c:${p.color}` },
      }).range(from, to));
    }
    marks.push(Decoration.widget({ widget: new CaretWidget(p.name, p.color, p.selAt || 0), side: h >= a ? 1 : -1 }).range(h));
  }
  return Decoration.set(marks, true);
}

export const remoteCarets = [
  ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.decorations = build(view);
      this.off = onSelectionChange(() => {
        try { view.dispatch({ effects: caretsRefresh.of(null) }); } catch (_) { /* destroyed */ }
      });
    }
    update(u) {
      if (u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(caretsRefresh)))) {
        this.decorations = build(u.view);
      }
    }
    destroy() { this.off(); }
  }, { decorations: (v) => v.decorations }),
  EditorView.baseTheme({
    '.pyx-rsel': { backgroundColor: 'color-mix(in srgb, var(--c) 22%, transparent)' },
    '.pyx-rcaret': {
      position: 'relative',
      borderLeft: '2px solid var(--c)',
      marginLeft: '-1px',
      marginRight: '-1px',
      pointerEvents: 'auto',
    },
    '.pyx-rcaret-flag': {
      position: 'absolute',
      top: '-1.25em',
      left: '-2px',
      padding: '0 4px',
      fontSize: '10.5px',
      lineHeight: '1.3em',
      fontFamily: 'system-ui, sans-serif',
      fontWeight: '600',
      whiteSpace: 'nowrap',
      color: '#fff',
      background: 'var(--c)',
      borderRadius: '3px 3px 3px 0',
      opacity: '0',
      animation: 'pyx-rcaret-flag 2.6s ease-out',
      pointerEvents: 'none',
      zIndex: '5',
      userSelect: 'none',
    },
    '.pyx-rcaret:hover .pyx-rcaret-flag': { opacity: '1', animation: 'none' },
    '@keyframes pyx-rcaret-flag': { '0%, 75%': { opacity: '1' }, '100%': { opacity: '0' } },
  }),
];
