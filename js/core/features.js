// Features that are built but not offered yet.
//
// COLLAB — the shared session (several people editing one project at once,
// js/collab/, server/). It stays in the code, tested and up to date, but no
// part of the interface leads to it: no «Compartir» button, no side panel,
// no dialog. Nothing of it runs unless it is switched on here, so it cannot
// change how the rest of Pyx behaves. To offer it again: `collab: true`.
export const FEATURES = Object.freeze({
  collab: false,
});
