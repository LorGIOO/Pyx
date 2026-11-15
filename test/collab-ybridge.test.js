// @vitest-environment jsdom
// The REAL editor (setup.js + CodeMirror) tied to Yjs (collab/ybridge.js):
// two "windows" share one document through a pair of Y.Docs, the way host
// and guest do. Typing on one side shows on the other, background tabs keep
// receiving, Ctrl+Z undoes only your own typing, and the permission filter
// refuses at the keyboard what the host would undo.
import { describe, it, expect, beforeAll } from 'vitest';
import * as Y from 'yjs';

let state, setup, bridge, hooks, commands;

beforeAll(async () => {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
  }
  ({ state } = await import('../js/core/state.js'));
  setup = await import('../js/editor/setup.js');
  bridge = await import('../js/collab/ybridge.js');
  ({ collabHooks: hooks } = await import('../js/collab/hooks.js'));
  commands = await import('@codemirror/commands');
});

/** Two Y.Docs that relay their updates to each other (a perfect network). */
function linkedPair() {
  const a = new Y.Doc(), b = new Y.Doc();
  a.on('update', (u, o) => { if (o !== 'net') Y.applyUpdate(b, u, 'net'); });
  b.on('update', (u, o) => { if (o !== 'net') Y.applyUpdate(a, u, 'net'); });
  return [a, b];
}

describe('collab · editor ⇄ Yjs', () => {
  it('lo escrito en un lado aparece en el otro, también en una pestaña de fondo', () => {
    state.documents.push(
      { id: 11, fileName: 'a.pltx', path: null, modified: false },
      { id: 12, fileName: 'b.pltx', path: null, modified: false },
    );
    setup.registerDoc(11, 'Hola mundo\n');
    setup.registerDoc(12, '');
    const view = setup.mountPane(7, document.body.appendChild(document.createElement('div')));
    setup.showDocInPane(7, 11);
    const [ya, yb] = linkedPair();
    bridge.bindDoc(11, ya, 'main.pltx', { from: 'cm' });   // "host": text from the editor
    bridge.bindDoc(12, yb, 'main.pltx', { from: 'y' });    // "guest": text from Yjs (doc 12 has no view)
    expect(setup.getDocContent(12)).toBe('Hola mundo\n');

    view.dispatch({ changes: { from: 4, insert: ',' } });   // typed on the host
    expect(setup.getDocContent(12)).toBe('Hola, mundo\n');

    setup.applyDocChanges(12, { from: 0, insert: '¡' });   // the guest (background tab) edits
    expect(view.state.doc.toString()).toBe('¡Hola, mundo\n');
    expect(ya.getText('t').toString()).toBe(yb.getText('t').toString());
  });

  it('Ctrl+Z deshace solo lo propio, nunca lo de los demás', () => {
    const view = setup.getViewOfDoc(11);
    const before = view.state.doc.toString();
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'mío' }, userEvent: 'input' });
    setup.applyDocChanges(12, { from: 0, insert: 'SUYO ' }); // the other person
    expect(view.state.doc.toString()).toBe('SUYO ' + before + 'mío');
    commands.undo(view);
    expect(view.state.doc.toString()).toBe('SUYO ' + before);
    expect(setup.getDocContent(12)).toBe('SUYO ' + before);
  });

  it('las ediciones remotas no marcan el documento como propio si la sesión lo dice', () => {
    hooks.modified = (id) => id !== 12;
    const d12 = state.documents.find((d) => d.id === 12);
    d12.modified = false;
    setup.getViewOfDoc(11).dispatch({ changes: { from: 0, insert: 'x' } });
    expect(d12.modified).toBe(false);
    hooks.modified = null;
  });

  it('el filtro de permisos rechaza en el teclado, no lo que llega de fuera', () => {
    const view = setup.getViewOfDoc(11);
    const t0 = view.state.doc.toString();
    hooks.filter = (id) => id !== 11; // only the first window is restricted
    view.dispatch({ changes: { from: 0, insert: 'NO' } });
    expect(view.state.doc.toString()).toBe(t0);
    // A remote edit is never filtered.
    setup.applyDocChanges(12, { from: 0, insert: 'sí ' });
    expect(view.state.doc.toString()).toBe('sí ' + t0);
    hooks.filter = null;
  });

  it('las posiciones relativas siguen al texto', () => {
    const view = setup.getViewOfDoc(11);
    const i = view.state.doc.toString().indexOf('mundo');
    const rel = bridge.relFromIndex(11, i);
    setup.applyDocChanges(12, { from: 0, insert: '12345' });
    expect(bridge.indexFromRel(11, rel)).toBe(i + 5);
    expect(view.state.doc.sliceString(i + 5, i + 10)).toBe('mundo');
  });

  it('desvincular corta el paso', () => {
    bridge.unbindDoc(12);
    setup.getViewOfDoc(11).dispatch({ changes: { from: 0, insert: 'solo aquí ' } });
    expect(setup.getDocContent(12).startsWith('solo aquí')).toBe(false);
    bridge.unbindAll();
  });
});
