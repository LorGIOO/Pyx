// @vitest-environment jsdom
// The REAL editor host (js/editor/setup.js) with real CodeMirror views: what
// belongs to one document must not leak into another when tabs change, and a
// document without a view (a background tab) can still be edited.

import { describe, it, expect, beforeAll, vi } from 'vitest';

let state, setup, docSnap, cursor;

beforeAll(async () => {
  // CodeMirror measures the DOM; jsdom has no layout.
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
  }
  ({ state } = await import('../js/core/state.js'));
  setup = await import('../js/editor/setup.js');
  ({ docSnap } = await import('../js/solid/stores/structureStore.js'));
  cursor = await import('../js/editor/cursor-history.js');

  state.documents.push(
    { id: 1, fileName: 'uno.tex', path: null, modified: false },
    { id: 2, fileName: 'dos.tex', path: null, modified: false },
    { id: 3, fileName: 'figura.png', path: null, modified: false, kind: 'image' },
  );
  setup.registerDoc(1, 'uno\n'.repeat(40));
  setup.registerDoc(2, 'dos\n'.repeat(40));
  setup.mountPane(1, document.body.appendChild(document.createElement('div')));
  state.panes[0].docId = 1;
  state.activeIndex = 0;
  setup.showDocInPane(1, 1);
});

describe('documents and panes', () => {
  it('getDocText is the same object while the text is unchanged', () => {
    const a = setup.getDocText(1);
    expect(setup.getDocText(1)).toBe(a);
    expect(setup.getDocText(2).toString()).toBe('dos\n'.repeat(40));
    expect(setup.getDocText(99)).toBeNull();
    setup.getViewOfDoc(1).dispatch({ changes: { from: 0, insert: '% ' } });
    expect(setup.getDocText(1)).not.toBe(a);
    expect(state.documents[0].modified).toBe(true);
  });

  it('F7d · a document in a background tab is changed in the editor, and marked', () => {
    expect(setup.getViewOfDoc(2)).toBeNull(); // no pane shows it
    expect(state.documents[1].modified).toBe(false);
    expect(setup.applyDocChanges(2, [{ from: 0, to: 3, insert: 'DOS' }, { from: 4, to: 7, insert: 'tres' }])).toBe(true);
    expect(setup.getDocContent(2).startsWith('DOS\ntres\ndos\n')).toBe(true);
    expect(state.documents[1].modified).toBe(true);
    // A document that is not open: nothing to change.
    expect(setup.applyDocChanges(99, { from: 0, insert: 'x' })).toBe(false);
    // In a pane it is an ordinary transaction on that view.
    expect(setup.applyDocChanges(1, { from: 0, to: 2, insert: '' })).toBe(true);
    expect(setup.getDocContent(1).startsWith('uno\n')).toBe(true);
  });

  it('F11 · a pending publish does not put the previous tab\'s text in the side panel', () => {
    vi.useFakeTimers();
    try {
      // Type in document 1 (arms the 200 ms publish), then change tab at once.
      setup.getViewOfDoc(1).dispatch({ changes: { from: 0, insert: 'X' } });
      state.panes[0].docId = 2;
      state.activeIndex = 1;
      setup.showDocInPane(1, 2);
      expect(docSnap().toString().startsWith('DOS')).toBe(true);
      vi.advanceTimersByTime(1000);
      // Still document 2: the timer of document 1 was dropped.
      expect(docSnap().toString().startsWith('DOS')).toBe(true);
      // …and the edit itself was not lost with it.
      expect(setup.getDocContent(1).startsWith('Xuno')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('F11 · the ribbon has no editor to act on while a viewer tab is in front', async () => {
    const commands = await import('../js/editor/commands.js');
    // Document 2 is shown in the pane; make the image tab the active one.
    const before = setup.getDocContent(2);
    state.activeIndex = 2;
    commands.insertCell();           // would have inserted into document 2
    commands.tblAddRow();
    expect(setup.getDocContent(2)).toBe(before);
    // Back on the text document, the same command does act.
    state.activeIndex = 1;
    commands.insertCell();
    expect(setup.getDocContent(2)).not.toBe(before);
  });

  it('F11 · with one document in two panes, stored positions move once per edit', async () => {
    // A second pane on document 2 (forked state, edits mirrored).
    state.panes.push({ id: 2, docId: 2 });
    setup.mountPane(2, document.body.appendChild(document.createElement('div')));
    setup.showDocInPane(2, 2);
    const [a, b] = [setup.getViewOfDoc(2), null];
    expect(a).toBeTruthy();
    const views = [];
    setup.forEachEditorView((v) => views.push(v));
    const [v1, v2] = views;
    expect(v1.state.doc.toString()).toBe(v2.state.doc.toString());
    void b;

    // Make a history entry far down the document: jump there, then far away.
    const far = v1.state.doc.line(30).from;
    v1.focus();
    v1.dispatch({ selection: { anchor: far } });
    v1.dispatch({ selection: { anchor: 0 } });
    const stored = () => cursor._historyState().back.filter((e) => e.docId === 2).map((e) => e.pos);
    const before = stored();
    expect(before.length).toBeGreaterThan(0);
    // Ten characters typed at the very start, in pane 1; pane 2 mirrors them.
    v1.dispatch({ changes: { from: 0, insert: '0123456789' } });
    expect(v2.state.doc.toString()).toBe(v1.state.doc.toString());
    // Each stored position moved by 10 — not by 20.
    expect(stored()).toEqual(before.map((p) => p + 10));
  });
});
