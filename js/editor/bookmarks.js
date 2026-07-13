// TeXstudio-style line bookmarks. Click the bookmark gutter (left of the line
// numbers) to toggle one; Ctrl+F2 toggles at the cursor, F2 jumps to the next
// and Shift+F2 to the previous (wrapping around). Bookmarks live in the
// EditorState — per document, they survive tab/pane switches — and follow
// edits via position mapping.

import { StateField, StateEffect, RangeSet } from '@codemirror/state';
import { gutter, GutterMarker } from '@codemirror/view';

const toggleEffect = StateEffect.define(); // value: line-start pos

class BookmarkMarker extends GutterMarker {
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-bookmark';
    s.textContent = '●';
    return s;
  }
}
const MARK = new BookmarkMarker();

const bookmarkField = StateField.define({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(toggleEffect)) {
        const pos = e.value;
        let has = false;
        set.between(pos, pos, () => { has = true; return false; });
        set = has
          ? set.update({ filter: (from) => from !== pos })
          : set.update({ add: [MARK.range(pos)] });
      }
    }
    return set;
  },
});

const bookmarkGutter = gutter({
  class: 'cm-bookmark-gutter',
  markers: (view) => view.state.field(bookmarkField),
  initialSpacer: () => MARK,
  domEventHandlers: {
    mousedown(view, line) {
      view.dispatch({ effects: toggleEffect.of(line.from) });
      return true;
    },
  },
});

export function toggleBookmarkAtCursor(view) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  view.dispatch({ effects: toggleEffect.of(line.from) });
  return true;
}

function jump(view, dir) {
  const set = view.state.field(bookmarkField);
  const all = [];
  const it = set.iter();
  while (it.value) { all.push(it.from); it.next(); }
  if (!all.length) return true;
  const cur = view.state.doc.lineAt(view.state.selection.main.head).from;
  let target = dir > 0
    ? all.find((p) => p > cur)
    : [...all].reverse().find((p) => p < cur);
  if (target == null) target = dir > 0 ? all[0] : all[all.length - 1]; // wrap
  view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
  return true;
}
export const nextBookmark = (view) => jump(view, 1);
export const prevBookmark = (view) => jump(view, -1);

export const bookmarks = [bookmarkField, bookmarkGutter];
