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
  files: new Map(),      // path -> Uint8Array: what readBinaryFile finds
  reads: [],             // every path read
  readGate: null,        // when set, reads wait on this promise
  ask: [],               // queued answers for askDialog (default: true)
  askedYesNo: [],
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
    askDialog: async (m) => { h.askedYesNo.push(m); return h.ask.length ? h.ask.shift() : true; },
    readBinaryFile: async (path) => {
      h.reads.push(path);
      if (h.readGate) await h.readGate;
      if (!h.files.has(path)) throw new Error(`No se pudo leer ${path}`);
      return h.files.get(path);
    },
    pltxRead: async () => ({ is_zip: true, source: 'fuente del pltx', outputs: null }),
  };
});

const { state } = await import('../js/core/state.js');
const store = await import('../js/solid/stores/docStore.js');
const { general } = await import('../js/solid/stores/settingsStore.js');

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
  h.files.clear(); h.reads.length = 0; h.readGate = null;
  h.ask.length = 0; h.askedYesNo.length = 0;
  general.encoding = 'UTF-8';
});

describe('F9 · autosave', () => {
  it('saves every modified document that has a file — silently', async () => {
    const compiler = await import('../js/compile/compiler.js');
    compiler.compileActive.mockClear();
    const front = docOf(store.newDocument('a', 'a.tex', 'C:\\p\\a.tex'));
    const back = docOf(store.newDocument('b', 'b.tex', 'C:\\p\\b.tex'));
    const pltx = docOf(store.newDocument('c', 'c.pltx', 'C:\\p\\c.pltx'));
    const clean = docOf(store.newDocument('d', 'd.tex', 'C:\\p\\d.tex'));
    const untitled = docOf(store.newDocument('e', 'sin-título.pltx', null));
    // A .tex that gained a Python cell: an explicit save asks «Guardar como».
    const gained = docOf(store.newDocument('f', 'f.tex', 'C:\\p\\f.tex'));
    // The space just typed at the end of the line must survive.
    type(front, 'texto con espacio al final \n');
    type(back, 'b2'); type(pltx, 'c2'); type(untitled, 'e2');
    type(gained, 'hola\n%#python\nx = 1\n%#end\n');
    general.trimOnSave = true;
    try {
      expect(await store.autosaveAll()).toBe(3);
    } finally {
      general.trimOnSave = false;
    }
    // Not only the tab in front; the text exactly as typed.
    expect(h.writes).toEqual([
      { kind: 'text', path: 'C:\\p\\a.tex', content: 'texto con espacio al final \n' },
      { kind: 'text', path: 'C:\\p\\b.tex', content: 'b2' },
      { kind: 'pltx', path: 'C:\\p\\c.pltx', content: 'c2' },
    ]);
    expect([front, back, pltx, clean].map((d) => d.modified)).toEqual([false, false, false, false]);
    // What would need a dialog is left for the user's own save — untouched.
    expect(untitled.modified).toBe(true);
    expect(gained.modified).toBe(true);
    expect(h.asked).toEqual([]);
    expect(h.messages).toEqual([]);
    // No compile, so the PDF viewer is not brought up every few minutes.
    await new Promise((r) => setTimeout(r, 0));
    expect(compiler.compileActive).not.toHaveBeenCalled();
    // An explicit save still compiles.
    type(front, 'otra vez');
    await store.saveActive();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('F4 · one tab per file', () => {
  it('the same file under another spelling is the tab that is already open', async () => {
    h.files.set('C:\\p\\a.tex', new TextEncoder().encode('hola'));
    await store.openPath('C:\\p\\a.tex');
    expect(state.documents).toHaveLength(1);
    for (const alias of ['C:/p/a.tex', 'c:\\P\\A.TEX', 'C:\\p\\.\\a.tex', 'C:\\p\\sub\\..\\a.tex']) {
      await store.openPath(alias);
    }
    expect(state.documents).toHaveLength(1);
    expect(h.reads).toEqual(['C:\\p\\a.tex']); // never read again
  });

  it('a double click opens it once: the open in flight is shared', async () => {
    h.files.set('C:\\p\\a.tex', new TextEncoder().encode('hola'));
    let release;
    h.readGate = new Promise((r) => { release = r; });
    const first = store.openPath('C:\\p\\a.tex');
    const second = store.openPath('C:/p/a.tex'); // before the first finished
    release();
    await Promise.all([first, second]);
    expect(state.documents).toHaveLength(1);
    expect(h.reads).toHaveLength(1);
    // …and once it is done, the key is free again (close and reopen works).
    await store.closeDocument(0);
    await store.openPath('C:\\p\\a.tex');
    expect(state.documents).toHaveLength(1);
    expect(h.reads).toHaveLength(2);
  });

  it('a file that cannot be read says so and leaves no tab or stuck key', async () => {
    await store.openPath('C:\\p\\no-existe.tex');
    expect(state.documents).toHaveLength(0);
    expect(h.messages.join(' ')).toContain('no-existe.tex');
    h.files.set('C:\\p\\no-existe.tex', new TextEncoder().encode('ya está'));
    await store.openPath('C:\\p\\no-existe.tex');
    expect(state.documents).toHaveLength(1);
  });
});

describe('F5 · renaming and deleting files that are open', () => {
  it('the tab follows a renamed file, and the files of a renamed folder', async () => {
    const a = docOf(store.newDocument('a', 'a.tex', 'C:\\p\\a.tex'));
    const ch = docOf(store.newDocument('c', 'cap1.tex', 'C:\\p\\caps\\cap1.tex'));
    const other = docOf(store.newDocument('o', 'ab.tex', 'C:\\p\\ab.tex'));
    store.pathRenamed('C:/p/A.tex', 'C:\\p\\informe.tex'); // spelled differently
    expect(a.path).toBe('C:\\p\\informe.tex');
    expect(a.fileName).toBe('informe.tex');
    store.pathRenamed('C:\\p\\caps', 'C:\\p\\capitulos');
    expect(ch.path).toBe('C:\\p\\capitulos\\cap1.tex');
    expect(ch.fileName).toBe('cap1.tex');
    expect(other.path).toBe('C:\\p\\ab.tex'); // a prefix of a NAME is not a folder
    // Saving now writes the new path, not the old one.
    type(a, 'a2');
    expect(await store.saveDocument(a)).toBe(true);
    expect([...h.disk.keys()]).toEqual(['C:\\p\\informe.tex']);
  });

  it('a deleted file closes its tab — unless it holds unsaved text', async () => {
    store.newDocument('a', 'a.tex', 'C:\\p\\a.tex');
    const edited = docOf(store.newDocument('b', 'b.tex', 'C:\\p\\sub\\b.tex'));
    store.newDocument('c', 'c.tex', 'C:\\p\\sub\\c.tex');
    store.newDocument('d', 'd.tex', 'C:\\otro\\d.tex');
    type(edited, 'sin guardar');
    store.pathRemoved('C:\\p\\a.tex');
    expect(state.documents.map((d) => d.fileName)).toEqual(['b.tex', 'c.tex', 'd.tex']);
    store.pathRemoved('C:\\p\\sub'); // a folder: everything under it
    expect(state.documents.map((d) => d.fileName)).toEqual(['b.tex', 'd.tex']);
    expect(edited.modified).toBe(true);
    expect(h.asked).toEqual([]); // nothing was asked
  });
});

describe('F6 · a file is saved the way it was opened', () => {
  const cp1252 = (s) => Uint8Array.from([...s].map((c) => ({ 'ó': 0xF3, 'ñ': 0xF1, '€': 0x80 }[c] ?? c.charCodeAt(0))));

  it('Windows-1252 with CRLF comes back as Windows-1252 with CRLF, whatever the setting says', async () => {
    h.files.set('C:\\p\\viejo.tex', cp1252('secci\u00f3n\r\na\u00f1o \u20ac\r\n'));
    await store.openPath('C:\\p\\viejo.tex');
    const doc = state.documents[0];
    expect(doc.format).toEqual({ encoding: 'windows-1252', bom: false, eol: '\r\n' });
    // What the editor holds (CodeMirror keeps LF only).
    type(doc, 'sección\naño €\nfin\n');
    expect(general.encoding).toBe('UTF-8');
    expect(await store.saveDocument(doc)).toBe(true);
    const w = h.writes[0];
    expect(w.kind).toBe('bytes');
    expect([...w.content]).toEqual([...cp1252('secci\u00f3n\r\na\u00f1o \u20ac\r\nfin\r\n')]);
    expect(doc.modified).toBe(false);
  });

  it('a UTF-8 BOM is kept; a plain UTF-8 LF file is written as plain text', async () => {
    h.files.set('C:\\p\\bom.tex', Uint8Array.from([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode('año\n')]));
    h.files.set('C:\\p\\utf8.tex', new TextEncoder().encode('año\n'));
    await store.openPath('C:\\p\\bom.tex');
    await store.openPath('C:\\p\\utf8.tex');
    const [bom, utf8] = state.documents;
    expect(bom.format).toEqual({ encoding: 'utf-8', bom: true, eol: '\n' });
    type(bom, 'año 2\n'); type(utf8, 'año 2\n');
    await store.saveDocument(bom);
    await store.saveDocument(utf8);
    expect([...h.writes[0].content]).toEqual([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode('año 2\n')]);
    expect(h.writes[1]).toEqual({ kind: 'text', path: 'C:\\p\\utf8.tex', content: 'año 2\n' });
  });

  it('a pure-ASCII file and a new document take the encoding of Configuración', async () => {
    general.encoding = 'Windows-1252';
    h.files.set('C:\\p\\ascii.tex', new TextEncoder().encode('hola\r\n'));
    await store.openPath('C:\\p\\ascii.tex');
    const doc = state.documents[0];
    expect(doc.format).toEqual({ encoding: 'windows-1252', bom: false, eol: '\r\n' });
    type(doc, 'año\n');
    await store.saveDocument(doc);
    expect([...h.writes[0].content]).toEqual([0x61, 0xF1, 0x6F, 0x0D, 0x0A]);
    // Changing the setting is an explicit request: open documents follow it.
    general.encoding = 'UTF-8';
    store.applyEncodingSetting();
    expect(doc.format).toEqual({ encoding: 'utf-8', bom: false, eol: '\r\n' });
  });

  it('a character the encoding lacks is never written as "?": the save asks, and can go to UTF-8', async () => {
    h.files.set('C:\\p\\viejo.tex', cp1252('a\u00f1o\n'));
    await store.openPath('C:\\p\\viejo.tex');
    const doc = state.documents[0];
    type(doc, 'año → α\n');

    // Unattended (the compiler, autosave): refused, nothing written.
    await expect(store.saveWithEncoding(doc.path, 'año → α\n')).rejects.toThrow(/Windows-1252/);
    expect(await store.saveDocument(doc, { interactive: false })).toBe(false);
    expect(h.writes).toEqual([]);
    expect(doc.modified).toBe(true);
    expect(state.lastLog).toContain('→');

    // Interactive, «Cancelar»: nothing written, no error dialog.
    h.messages.length = 0;
    h.ask.push(false);
    expect(await store.saveDocument(doc)).toBe(false);
    expect(h.writes).toEqual([]);
    expect(h.messages).toEqual([]);
    expect(h.askedYesNo[0]).toContain('«→»');

    // Interactive, «Guardar en UTF-8»: the file becomes UTF-8, text intact.
    h.ask.push(true);
    expect(await store.saveDocument(doc)).toBe(true);
    expect(h.writes).toEqual([{ kind: 'text', path: 'C:\\p\\viejo.tex', content: 'año → α\n' }]);
    expect(doc.format.encoding).toBe('utf-8');
    expect(doc.modified).toBe(false);
  });
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
