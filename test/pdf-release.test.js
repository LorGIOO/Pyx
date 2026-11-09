// The viewer releases the previous version of a PDF every time a recompiled
// one is shown. Checked against the INSTALLED pdfjs-dist, because the call it
// used (`doc.destroy()`) stopped existing in PDF.js 6 and nothing noticed:
// the TypeError landed in the middle of showing the new PDF, so the pages on
// screen stayed the old ones — "compiled, and the PDF does not change".
import { describe, it, expect } from 'vitest';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { destroyPdf } from '../js/pdf/pdf-release.js';

// The smallest PDF with one page.
function tinyPdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('liberar un documento de PDF.js', () => {
  it('libera el documento con la versión instalada, sin lanzar', async () => {
    const task = pdfjsLib.getDocument({ data: tinyPdf(), useWorkerFetch: false, isEvalSupported: false });
    const doc = await task.promise;
    expect(doc.numPages).toBe(1);
    expect(() => destroyPdf(doc)).not.toThrow();
    expect(task.destroyed).toBe(true);
    // Again, on a document already released: still nothing thrown.
    expect(() => destroyPdf(doc)).not.toThrow();
  });

  it('no lanza con nada de lo que le pueda llegar', () => {
    for (const odd of [null, undefined, {}, { loadingTask: {} }, { destroy: 3 },
      { destroy() { throw new Error('x'); } }, { loadingTask: { destroy() { return Promise.reject(new Error('y')); } } }]) {
      expect(() => destroyPdf(odd)).not.toThrow();
    }
  });

  it('usa el método del documento cuando existe (PDF.js 4)', () => {
    let called = 0;
    destroyPdf({ destroy() { called++; return Promise.resolve(); } });
    expect(called).toBe(1);
  });
});
