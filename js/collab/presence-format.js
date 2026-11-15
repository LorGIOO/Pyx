// The presence record each participant publishes (where they are, what they
// select, where their mouse is) and its validation. Pure, shared by both ends.
//
//   f   path of the file they have in front of them, or null
//   s   [anchor, head] of their selection in `f`, as encoded Yjs relative
//       positions (base64url) — they stay attached to the text while it moves
//   p   their mouse pointer:
//         {z:'ed', f, r, dx, dy}  over the editor: the character under it (r)
//                                 plus an offset in character widths / line
//                                 heights, so it lands on the same spot of the
//                                 TEXT whatever the other window's size or zoom
//         {z:'pdf', pg, x, y}     over the PDF: page and PDF points
//         {z:'ui', a}             elsewhere in the window (a = area name)
//         null                    outside the window
//   t   the top of their editor view (relative position), for «Seguir a»
//   pg  the PDF page they are looking at, for «Seguir a»

const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const REL = /^[A-Za-z0-9_-]{1,200}$/;
const AREAS = new Set(['ribbon', 'tabs', 'side', 'status', 'terminal', 'dialog', 'other']);

/** A clean copy of an untrusted presence record, or null. Unknown fields are
 *  dropped, strings are bounded, numbers clamped. */
export function cleanPresence(s) {
  if (!s || typeof s !== 'object') return null;
  const out = { f: null, s: null, p: null, t: null, pg: null };
  if (isStr(s.f, 512)) out.f = s.f;
  if (Array.isArray(s.s) && s.s.length === 2 && REL.test(s.s[0]) && REL.test(s.s[1])) out.s = [s.s[0], s.s[1]];
  if (typeof s.t === 'string' && REL.test(s.t)) out.t = s.t;
  const pg = num(s.pg, 1, 100000);
  if (pg != null) out.pg = Math.round(pg);
  const p = s.p;
  if (p && typeof p === 'object') {
    if (p.z === 'ed' && isStr(p.f, 512) && typeof p.r === 'string' && REL.test(p.r)) {
      const dx = num(p.dx, -400, 400), dy = num(p.dy, -50, 50);
      if (dx != null && dy != null) out.p = { z: 'ed', f: p.f, r: p.r, dx, dy };
    } else if (p.z === 'pdf') {
      const page = num(p.pg, 1, 100000), x = num(p.x, -2000, 20000), y = num(p.y, -2000, 20000);
      if (page != null && x != null && y != null) out.p = { z: 'pdf', pg: Math.round(page), x, y };
    } else if (p.z === 'ui' && AREAS.has(p.a)) {
      out.p = { z: 'ui', a: p.a };
    }
  }
  return out;
}

/** A display name someone typed: no control characters, bounded. */
export function cleanName(name) {
  const s = String(name || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim();
  return (s || 'Invitado').slice(0, 40);
}

export const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#e03131', '#5f3dc4', '#66a80f', '#c2255c'];
