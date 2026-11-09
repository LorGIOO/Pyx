// Releasing a PDF.js document.
//
// Its own module, with a test against the installed pdfjs-dist, because this
// one call is what broke the viewer in 1.6.6.
//
// PDF.js 4 had `PDFDocumentProxy.destroy()`. PDF.js 6 does not: a document is
// released through its loading task. The viewer still called `doc.destroy()`
// — a TypeError, thrown in the middle of showing a recompiled PDF, right
// after the new document had been made current and BEFORE its pages were laid
// out and painted. So from the second compile of a session on:
//   - the pages on screen stayed the old ones (they were only repainted when
//     the zoom changed or they scrolled far enough away) — "it says it
//     compiled and the PDF does not change";
//   - the status bar turned red over a compile that had gone fine;
//   - the old document was never released: one more held by the worker after
//     every compile, until it ran out of memory and no PDF loaded again
//     until Pyx was restarted.
//
// Never throws, whatever it is handed: releasing memory must not be able to
// stop a PDF from being shown.

/** Release a PDF.js document (any version's). */
export function destroyPdf(doc) {
  if (!doc) return;
  try {
    const task = doc.loadingTask;
    const p = task && typeof task.destroy === 'function'
      ? task.destroy()
      : (typeof doc.destroy === 'function' ? doc.destroy() : null);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) { /* already gone */ }
}
