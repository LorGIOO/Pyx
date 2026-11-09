// @vitest-environment jsdom
// The document store: what is on disk, what is only in memory, and what the
// user is asked before the difference is thrown away. The editor and the Tauri
// bridge are replaced by in-memory stand-ins; everything else is the real
// store.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  texts: new Map(),      // doc id -> text: the "editor"
  disk: new Map(),       // path -> what was last written there
  writes: [],            // every write, in order: { kind, path, content }
  gate: null,            // when set, writes wait on this promise
  choice: [],            // queued answers for choiceDialog
  asked: [],             // every choiceDialog message
  savePath: [],          // queued answers for the «Guardar como» dialog
  messages: [],
}));

vi.mock('../js/editor/setup.js', () => ({
  registerDoc: (id, content) => h.texts.set(id, content ?? ''),
  getDocContent: (id) => h.texts.get(id) ?? '',
  disposeDoc: (id) => h.texts.delete(id),
  getViewOfDoc: () => null,
  broadcastCellRefresh: () => {},
}));

vi.mock('../js/compile/compiler.js', () => ({
  compileActive: vi.fn(),
  showSavedPdf: vi.fn(),
  prewarmActive: vi.fn(),
}));

vi.mock('../js/core/platform.js', async (orig) => {
  const write = async (kind, path, content) => {
    if (h.gate) await h.gate;
    h.writes.push({ kind, path, content });
    h.disk.set(path, content);
  };
  return {
    ...(await orig()),
    isTauri: () => true,
    writeTextFile: (path, content) => write('text', path, content),
    writeBinaryFile: (path, bytes) => write('bytes', path, bytes),
    pltxWrite: (path, source) => write('pltx', path, source),
    saveFileDialog: async () => (h.savePath.length ? h.savePath.shift() : null),
    choiceDialog: async (message) => { h.asked.push(message); return h.choice.length ? h.choice.shift() : 'cancel'; },
    messageDialog: async (m) => { h.messages.push(m); },
    askDialog: async () => true,
  };
});

const { state } = await import('../js/core/state.js');
const store = await import('../js/solid/stores/docStore.js');

/** Type into the "editor" the way the real update listener does. */
function type(doc, text) {
  h.texts.set(doc.id, text);
  doc.modified = true;
}
const docOf = (id) => state.documents.find((d) => d.id === id);

beforeEach(() => {
  state.documents.splice(0);
  state.panes.splice(0, state.panes.length, { id: 1, docId: null });
  state.activePaneId = 1;
  state.activeIndex = -1;
  h.texts.clear(); h.disk.clear();
  h.writes.length = 0; h.choice.length = 0; h.asked.length = 0;
  h.savePath.length = 0; h.messages.length = 0;
  h.gate = null;
});

describe('F2 · text typed while a save is in flight', () => {
  it('stays marked as modified, and is cleared when nothing was typed', async () => {
    const doc = docOf(store.newDocument('uno', 'a.tex', 'C:\\p\\a.tex'));
    type(doc, 'uno dos');
    let release;
    h.gate = new Promise((r) => { release = r; });
    const saving = store.saveActive();
    await new Promise((r) => setTimeout(r, 0)); // the save has read the text and is writing
    type(doc, 'uno dos tres'); // typed while the write is still pending
    release();
    expect(await saving).toBe(true);
    expect(h.disk.get('C:\\p\\a.tex')).toBe('uno dos');
    expect(doc.modified).toBe(true); // "tres" is NOT on disk

    h.gate = null;
    expect(await store.saveActive()).toBe(true);
    expect(h.disk.get('C:\\p\\a.tex')).toBe('uno dos tres');
    expect(doc.modified).toBe(false);
  });

  it('holds for «Guardar como» too', async () => {
    const doc = docOf(store.newDocument('x', 'sin-título.tex', null));
    type(doc, 'x1');
    h.savePath.push('C:\\p\\nuevo.tex');
    let release;
    h.gate = new Promise((r) => { release = r; });
    const saving = store.saveActiveAs();
    await new Promise((r) => setTimeout(r, 0));
    type(doc, 'x1 y más');
    release();
    expect(await saving).toBe(true);
    expect(doc.path).toBe('C:\\p\\nuevo.tex');
    expect(doc.fileName).toBe('nuevo.tex');
    expect(doc.modified).toBe(true);
  });

  it('markSavedIfUnchanged is the helper the compiler uses', () => {
    const doc = docOf(store.newDocument('abc', 'a.tex', 'C:\\p\\a.tex'));
    doc.modified = true;
    expect(store.markSavedIfUnchanged(doc, 'ab')).toBe(false);
    expect(doc.modified).toBe(true);
    expect(store.markSavedIfUnchanged(doc, 'abc')).toBe(true);
    expect(doc.modified).toBe(false);
    expect(store.markSavedIfUnchanged(null, 'abc')).toBe(false);
  });

  it('two saves of one document never overlap', async () => {
    const doc = docOf(store.newDocument('a', 'a.tex', 'C:\\p\\a.tex'));
    type(doc, 'v1');
    let release;
    h.gate = new Promise((r) => { release = r; });
    const first = store.saveDocument(doc);
    const second = store.saveDocument(doc);
    await new Promise((r) => setTimeout(r, 0)); // the save has read the text and is writing
    type(doc, 'v2');
    release();
    await Promise.all([first, second]);
    // The second save started after the first finished, so it wrote v2.
    expect(h.writes.map((w) => w.content)).toEqual(['v1', 'v2']);
    expect(doc.modified).toBe(false);
  });

  it('a failed write leaves the document modified and says so', async () => {
    const doc = docOf(store.newDocument('a', 'a.tex', 'C:\\p\\a.tex'));
    type(doc, 'v1');
    h.gate = Promise.reject(new Error('disco lleno'));
    expect(await store.saveActive()).toBe(false);
    expect(doc.modified).toBe(true);
    expect(h.messages.join(' ')).toContain('disco lleno');
    // …silently when nobody asked for the save (autosave).
    h.messages.length = 0;
    h.gate = Promise.reject(new Error('disco lleno'));
    expect(await store.saveDocument(doc, { interactive: false })).toBe(false);
    expect(h.messages).toEqual([]);
    expect(state.lastLog).toContain('disco lleno');
  });
});

describe('F1 · leaving with unsaved documents', () => {
  it('asks nothing when everything is saved', async () => {
    store.newDocument('a', 'a.tex', 'C:\\p\\a.tex');
    expect(await store.resolveUnsaved()).toBe(true);
    expect(h.asked).toEqual([]);
  });

  it('«Cancelar» keeps the app open and writes nothing', async () => {
    const doc = docOf(store.newDocument('a', 'a.tex', 'C:\\p\\a.tex'));
    type(doc, 'cambios');
    h.choice.push('cancel');
    expect(await store.resolveUnsaved()).toBe(false);
    expect(h.asked[0]).toContain('a.tex');
    expect(h.writes).toEqual([]);
    expect(doc.modified).toBe(true);
  });

  it('«No guardar» lets it close without writing', async () => {
    const doc = docOf(store.newDocument('a', 'a.tex', 'C:\\p\\a.tex'));
    type(doc, 'cambios');
    h.choice.push('no');
    expect(await store.resolveUnsaved()).toBe(true);
    expect(h.writes).toEqual([]);
  });

  it('«Guardar» saves each one through its real path: text, .pltx container, «Guardar como»', async () => {
    const tex = docOf(store.newDocument('t', 'a.tex', 'C:\\p\\a.tex'));
    const pltx = docOf(store.newDocument('p', 'b.pltx', 'C:\\p\\b.pltx'));
    const untitled = docOf(store.newDocument('u', 'sin-título.pltx', null));
    const clean = docOf(store.newDocument('c', 'c.tex', 'C:\\p\\c.tex'));
    type(tex, 't2'); type(pltx, 'p2'); type(untitled, 'u2');
    h.choice.push('yes');
    h.savePath.push('C:\\p\\nuevo.pltx');
    expect(await store.resolveUnsaved()).toBe(true);
    expect(h.writes).toEqual([
      { kind: 'text', path: 'C:\\p\\a.tex', content: 't2' },
      { kind: 'pltx', path: 'C:\\p\\b.pltx', content: 'p2' },
      { kind: 'pltx', path: 'C:\\p\\nuevo.pltx', content: 'u2' },
    ]);
    expect([tex, pltx, untitled, clean].map((d) => d.modified)).toEqual([false, false, false, false]);
    expect(untitled.path).toBe('C:\\p\\nuevo.pltx');
    // One question for all of them, naming each.
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toContain('a.tex');
    expect(h.asked[0]).toContain('b.pltx');
    expect(h.asked[0]).not.toContain('c.tex');
  });

  it('a cancelled «Guardar como» cancels the close', async () => {
    const untitled = docOf(store.newDocument('u', 'sin-título.pltx', null));
    type(untitled, 'u2');
    h.choice.push('yes'); // and the save dialog answers null
    expect(await store.resolveUnsaved()).toBe(false);
    expect(untitled.modified).toBe(true);
  });

  it('a failed write cancels the close', async () => {
    const doc = docOf(store.newDocument('a', 'a.tex', 'C:\\p\\a.tex'));
    type(doc, 'cambios');
    h.choice.push('yes');
    h.gate = Promise.reject(new Error('solo lectura'));
    expect(await store.resolveUnsaved()).toBe(false);
    expect(doc.modified).toBe(true);
  });

  it('closing one tab offers the same three choices', async () => {
    const doc = docOf(store.newDocument('a', 'a.tex', 'C:\\p\\a.tex'));
    type(doc, 'cambios');
    h.choice.push('cancel');
    await store.closeDocument(0);
    expect(state.documents).toHaveLength(1);

    h.choice.push('yes');
    await store.closeDocument(0);
    expect(state.documents).toHaveLength(0);
    expect(h.disk.get('C:\\p\\a.tex')).toBe('cambios');

    const other = docOf(store.newDocument('b', 'b.tex', 'C:\\p\\b.tex'));
    type(other, 'se descarta');
    h.choice.push('no');
    await store.closeDocument(0);
    expect(state.documents).toHaveLength(0);
    expect(h.disk.has('C:\\p\\b.tex')).toBe(false);
  });
});
