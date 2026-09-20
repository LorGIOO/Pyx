// The app's own dialogs (Configuración, Nuevo documento, the Tabla/Imagen
// wizards) in one place, so two rules hold for all of them:
//
//   * Escape closes the one that is open. Every other panel in the app closes
//     with Escape; these did not, and the only way out was the ✕.
//   * Opening one closes the others. They are deliberately NOT modal (the
//     overlay lets clicks through, so the document stays usable underneath) —
//     which also meant a shortcut could stack "Nuevo documento" on top of
//     "Configuración", two panels overlapping with no way to tell which had
//     the keyboard.
//
// Each dialog registers a pair {isOpen, close}; nothing else is shared.

const dialogs = new Set();

/** Register a dialog. Returns the unregister function (for onCleanup). */
export function registerDialog(isOpen, close) {
  const entry = { isOpen, close };
  dialogs.add(entry);
  return () => dialogs.delete(entry);
}

/** Close every open dialog. Returns true if any was open. */
export function closeDialogs() {
  let closed = false;
  for (const d of dialogs) {
    try {
      if (d.isOpen()) { d.close(); closed = true; }
    } catch (_) { /* a dialog being torn down */ }
  }
  return closed;
}

/** Is any dialog on screen? */
export function anyDialogOpen() {
  for (const d of dialogs) {
    try { if (d.isOpen()) return true; } catch (_) { /* ignore */ }
  }
  return false;
}
