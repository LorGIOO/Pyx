// "Guardar una copia del PDF con las anotaciones": the review marks drawn INTO
// a copy of the PDF, as real page content — any viewer shows them, and they
// print.
//
// The marks come from the same description the screen uses (annot-geom.js
// markPaths / markTexts), so the copy shows what was drawn. pdf-lib is loaded
// only when an export is asked for.

import { markPaths, markTexts } from './annot-geom.js';

const hex = (c) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(c || ''));
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0, 0, 0];
};

/** Helvetica speaks WinAnsi: what it cannot write becomes "?", instead of an
 *  export that fails because a comment had an emoji in it. */
function encodable(font, str) {
  let out = '';
  for (const ch of String(str)) {
    if (ch === '\n') { out += ch; continue; } // a line break is layout, not a glyph
    if (ch === '\r') continue;
    try { font.encodeText(ch); out += ch; } catch (_) { out += ch === '\t' ? '    ' : '?'; }
  }
  return out;
}

/** Break `str` into lines no wider than `width` at `size` (words first; a
 *  word longer than the line is cut). */
function wrap(font, str, size, width) {
  const lines = [];
  for (const para of String(str).split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      if (font.widthOfTextAtSize(line + word, size) <= width || !line.trim()) {
        line += word;
        // One word wider than the box: cut it where it stops fitting.
        while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
          let n = line.length - 1;
          while (n > 1 && font.widthOfTextAtSize(line.slice(0, n), size) > width) n--;
          lines.push(line.slice(0, n));
          line = line.slice(n);
        }
      } else {
        lines.push(line.replace(/\s+$/, ''));
        line = word.replace(/^\s+/, '');
      }
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines;
}

/**
 * @param {Uint8Array} bytes  the PDF as it is on disk
 * @param {{marks: Object<string, object[]>, sizes: Object<string, {w:number,h:number}>}} data
 *   annotate.js annotationData()
 * @returns {Promise<Uint8Array>} the PDF with the marks drawn on its pages
 */
export async function annotatedPdf(bytes, data) {
  const {
    PDFDocument, StandardFonts, rgb, BlendMode, LineCapStyle,
    pushGraphicsState, popGraphicsState, concatTransformationMatrix,
  } = await import('pdf-lib');
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  for (const key of Object.keys(data.marks)) {
    const page = pages[+key - 1];
    const marks = data.marks[key];
    if (!page || !marks || !marks.length) continue;
    // The viewer's coordinates are those of the page AS SHOWN: its crop box,
    // rotated by /Rotate, origin at the top-left. One matrix takes that
    // "view" (y up, origin bottom-left of what is shown) back to the page.
    const box = page.getCropBox();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const vw = rot === 90 || rot === 270 ? box.height : box.width;
    const vh = rot === 90 || rot === 270 ? box.width : box.height;
    const m = rot === 90 ? [0, 1, -1, 0, box.x + box.width, box.y]
      : rot === 180 ? [-1, 0, 0, -1, box.x + box.width, box.y + box.height]
        : rot === 270 ? [0, -1, 1, 0, box.x, box.y + box.height]
          : [1, 0, 0, 1, box.x, box.y];
    // The marks were placed on the size the viewer measured; if it differs
    // from the page's (it should not), they are scaled onto it.
    const seen = data.sizes && data.sizes[key];
    const sx = seen && seen.w ? vw / seen.w : 1, sy = seen && seen.h ? vh / seen.h : 1;
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m));
    for (const a of marks) {
      for (const p of markPaths(a)) {
        if (!p.d) continue;
        const col = p.stroke ? rgb(...hex(p.stroke)) : undefined;
        const fill = p.fill ? rgb(...hex(p.fill)) : undefined;
        page.drawSvgPath(p.d, {
          x: 0, y: vh, scale: sx, // sy === sx for every real page
          borderColor: col,
          borderWidth: p.stroke ? p.w : 0,
          borderOpacity: p.stroke ? p.op : undefined,
          borderLineCap: LineCapStyle.Round,
          borderDashArray: p.dash || undefined,
          color: fill,
          opacity: fill ? p.op : undefined,
          blendMode: p.ink ? BlendMode.Multiply : undefined,
        });
      }
      for (const t of markTexts(a)) {
        const size = t.size * sy;
        const lines = wrap(font, encodable(font, t.str), size, Math.max(10, t.width * sx));
        const lh = size * (t.box ? 1.3 : 1.25);
        if (t.box) {
          // A comment's card: tinted paper with the note's colour at its edge.
          const [r, g, b] = hex(t.box);
          const w = Math.max(...lines.map((l) => font.widthOfTextAtSize(l, size)), 20) + 8;
          const h = lines.length * lh + 5;
          page.drawRectangle({
            x: (t.x - 3) * sx, y: vh - (t.y - 2) * sy - h, width: w, height: h,
            color: rgb(1 - (1 - r) * 0.16, 1 - (1 - g) * 0.16, 1 - (1 - b) * 0.16),
            borderColor: rgb(r, g, b), borderWidth: 0.6,
          });
        }
        lines.forEach((line, i) => {
          if (!line) return;
          page.drawText(line, {
            x: t.x * sx, y: vh - t.y * sy - size * 0.82 - i * lh, size, font, color: rgb(...hex(t.color)),
          });
        });
      }
    }
    page.pushOperators(popGraphicsState());
  }
  return pdf.save();
}
