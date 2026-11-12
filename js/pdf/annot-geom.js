// Geometry of the PDF review marks — pure functions, no DOM, unit-tested.
//
// Everything here works in PDF POINTS of a page (its size at scale 1, origin
// at the top-left, y down). One description of each mark (`markPaths`,
// `markTexts`) feeds BOTH the on-screen SVG and the exported PDF, so what is
// saved is what was drawn.

export const r2 = (v) => Math.round(v * 100) / 100;

/* ---------- paths ---------- */

/** A smooth path through freehand points: quadratic curves through the
 *  midpoints, so a pen stroke reads as ink, not as a polyline. */
export function smoothPath(p) {
  if (p.length < 2) return '';
  if (p.length < 6) {
    let d = `M${r2(p[0])} ${r2(p[1])}`;
    for (let i = 2; i + 1 < p.length; i += 2) d += ` L${r2(p[i])} ${r2(p[i + 1])}`;
    return p.length === 2 ? d + ' h0.01' : d;
  }
  let d = `M${r2(p[0])} ${r2(p[1])}`;
  for (let i = 2; i + 3 < p.length; i += 2) {
    d += ` Q${r2(p[i])} ${r2(p[i + 1])} ${r2((p[i] + p[i + 2]) / 2)} ${r2((p[i + 1] + p[i + 3]) / 2)}`;
  }
  return d + ` L${r2(p[p.length - 2])} ${r2(p[p.length - 1])}`;
}

/** Straight segments through flat points [x, y, x, y…] (what is left of a
 *  shape after the eraser cut it: its corners must stay corners). */
export function polyPath(p) {
  if (p.length < 2) return '';
  let d = `M${r2(p[0])} ${r2(p[1])}`;
  for (let i = 2; i + 1 < p.length; i += 2) d += ` L${r2(p[i])} ${r2(p[i + 1])}`;
  return p.length === 2 ? d + ' h0.01' : d;
}

const K = 0.5522847498; // circle → cubic Béziers
function ellipsePath(cx, cy, rx, ry) {
  const ox = rx * K, oy = ry * K;
  return `M${r2(cx + rx)} ${r2(cy)}`
    + ` C${r2(cx + rx)} ${r2(cy + oy)} ${r2(cx + ox)} ${r2(cy + ry)} ${r2(cx)} ${r2(cy + ry)}`
    + ` C${r2(cx - ox)} ${r2(cy + ry)} ${r2(cx - rx)} ${r2(cy + oy)} ${r2(cx - rx)} ${r2(cy)}`
    + ` C${r2(cx - rx)} ${r2(cy - oy)} ${r2(cx - ox)} ${r2(cy - ry)} ${r2(cx)} ${r2(cy - ry)}`
    + ` C${r2(cx + ox)} ${r2(cy - ry)} ${r2(cx + rx)} ${r2(cy - oy)} ${r2(cx + rx)} ${r2(cy)} Z`;
}
function rectPath(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!r) return `M${r2(x)} ${r2(y)} L${r2(x + w)} ${r2(y)} L${r2(x + w)} ${r2(y + h)} L${r2(x)} ${r2(y + h)} Z`;
  return `M${r2(x + r)} ${r2(y)} L${r2(x + w - r)} ${r2(y)} Q${r2(x + w)} ${r2(y)} ${r2(x + w)} ${r2(y + r)}`
    + ` L${r2(x + w)} ${r2(y + h - r)} Q${r2(x + w)} ${r2(y + h)} ${r2(x + w - r)} ${r2(y + h)}`
    + ` L${r2(x + r)} ${r2(y + h)} Q${r2(x)} ${r2(y + h)} ${r2(x)} ${r2(y + h - r)}`
    + ` L${r2(x)} ${r2(y + r)} Q${r2(x)} ${r2(y)} ${r2(x + r)} ${r2(y)} Z`;
}

/* ---------- lines and arrows: straight, curved, elbowed ---------- */

/** Where a line or arrow is "held" in the middle: the point the curve passes
 *  through, or the centre of an elbow's cross segment. */
export function lineMid(a) {
  if (a.kind === 'curve' && a.mx != null) return [a.mx, a.my];
  if (a.kind === 'elbow') {
    if (a.el === 'v') { const my = a.my != null ? a.my : (a.y0 + a.y1) / 2; return [(a.x0 + a.x1) / 2, my]; }
    const mx = a.mx != null ? a.mx : (a.x0 + a.x1) / 2;
    return [mx, (a.y0 + a.y1) / 2];
  }
  return [(a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2];
}

/** The line as a polyline [[x, y]…]: 2 points when straight, 4 for an elbow,
 *  a sampled quadratic for a curve. Drawing, hit-testing, the arrow heads and
 *  the export all read this one shape. */
export function linePoints(a) {
  if (a.kind === 'curve' && a.mx != null) {
    // The curve passes THROUGH (mx, my) at its middle: control = 2m − (p0+p1)/2.
    const cx = 2 * a.mx - (a.x0 + a.x1) / 2, cy = 2 * a.my - (a.y0 + a.y1) / 2;
    const out = [];
    for (let i = 0; i <= 32; i++) {
      const t = i / 32, u = 1 - t;
      out.push([u * u * a.x0 + 2 * u * t * cx + t * t * a.x1, u * u * a.y0 + 2 * u * t * cy + t * t * a.y1]);
    }
    return out;
  }
  if (a.kind === 'elbow') {
    const [mx, my] = lineMid(a);
    return a.el === 'v'
      ? [[a.x0, a.y0], [a.x0, my], [a.x1, my], [a.x1, a.y1]]
      : [[a.x0, a.y0], [mx, a.y0], [mx, a.y1], [a.x1, a.y1]];
  }
  return [[a.x0, a.y0], [a.x1, a.y1]];
}

/** Which ends carry a head: 'end' | 'both' | 'start' | 'none'. */
export const headsOf = (a) => a.heads || (a.t === 'arrow' ? 'end' : 'none');

/** Unit direction INTO the end of a polyline (its last segment with length). */
function dirInto(pts, atEnd) {
  const seq = atEnd ? pts : [...pts].reverse();
  for (let i = seq.length - 1; i > 0; i--) {
    const dx = seq[i][0] - seq[i - 1][0], dy = seq[i][1] - seq[i - 1][1];
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) return [dx / len, dy / len];
  }
  return [1, 0];
}
/** Shorten a polyline by `len` at its end (so a thick shaft stops at the base
 *  of the head instead of poking through its tip). */
function trimEnd(pts, len) {
  const out = pts.map((p) => [...p]);
  let left = len;
  while (out.length > 1 && left > 0) {
    const a = out[out.length - 2], b = out[out.length - 1];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (seg > left) {
      const k = (seg - left) / seg;
      out[out.length - 1] = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      return out;
    }
    left -= seg;
    out.pop();
  }
  return out;
}
const polyLen = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
const flat = (pts) => pts.flatMap((p) => p);

/** Size of an arrow head for a stroke of width `w`: [length, width]. */
export function headSize(w, len) {
  const L = Math.min(len, Math.max(7, w * 4));
  return [L, L * 0.62];
}

/* ---------- one description for the screen and for the exported PDF ---------- */

const dashOf = (a) => (a.dash ? [r2(Math.max(2, a.w * 3)), r2(Math.max(1.6, a.w * 2.2))] : null);

/** The mark as drawing primitives:
 *  [{ d, stroke, fill, w, op, dash, ink }] — `ink` ones multiply with the page
 *  (a highlight never washes out the words under it). Text is in markTexts. */
export function markPaths(a) {
  const base = { stroke: a.c, fill: null, w: a.w, op: 1, dash: dashOf(a), ink: false };
  if (a.t === 'pen') return [{ ...base, d: a.poly ? polyPath(a.pts) : smoothPath(a.pts) }];
  if (a.t === 'highlight') return [{ ...base, d: a.poly ? polyPath(a.pts) : smoothPath(a.pts), op: 0.45, ink: true, dash: null }];
  if (a.t === 'mark') {
    return a.rects.map(([x, y, w, h]) => {
      if (a.k === 'hl') {
        return { d: rectPath(x, y, w, h, Math.min(1.5, h / 6)), stroke: null, fill: a.c, w: 0, op: 0.45, dash: null, ink: true };
      }
      const yy = a.k === 'ul' ? y + h * 0.94 : y + h * 0.56;
      return { d: `M${r2(x)} ${r2(yy)} L${r2(x + w)} ${r2(yy)}`, stroke: a.c, fill: null, w: r2(Math.max(0.8, h * 0.08)), op: 1, dash: null, ink: false };
    });
  }
  if (a.t === 'rect') {
    return [{ ...base, d: rectPath(Math.min(a.x0, a.x1), Math.min(a.y0, a.y1), Math.abs(a.x1 - a.x0), Math.abs(a.y1 - a.y0), a.round ? 8 : 1.5) }];
  }
  if (a.t === 'ellipse') {
    return [{ ...base, d: ellipsePath((a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2, Math.abs(a.x1 - a.x0) / 2, Math.abs(a.y1 - a.y0) / 2) }];
  }
  if (a.t === 'line' || a.t === 'arrow') {
    let pts = linePoints(a);
    const heads = headsOf(a);
    const out = [];
    const total = polyLen(pts);
    const [L, W] = headSize(a.w, heads === 'both' ? total / 2 : total);
    const head = (tip, [ux, uy]) => {
      const bx = tip[0] - ux * L, by = tip[1] - uy * L;
      out.push({
        d: `M${r2(tip[0])} ${r2(tip[1])} L${r2(bx - uy * W / 2)} ${r2(by + ux * W / 2)} L${r2(bx + uy * W / 2)} ${r2(by - ux * W / 2)} Z`,
        stroke: a.c, fill: a.c, w: r2(Math.min(a.w, 1.2)), op: 1, dash: null, ink: false,
      });
    };
    if (total > 0.01 && (heads === 'end' || heads === 'both')) {
      head(pts[pts.length - 1], dirInto(pts, true));
      pts = trimEnd(pts, L - 0.5);
    }
    if (total > 0.01 && (heads === 'start' || heads === 'both')) {
      const rev = [...pts].reverse();
      head(rev[rev.length - 1], dirInto(rev, true));
      pts = trimEnd(rev, L - 0.5).reverse();
    }
    // A sampled curve is drawn through its samples as a smooth path again.
    const d = a.kind === 'curve' && a.mx != null ? smoothPath(flat(pts)) : polyPath(flat(pts));
    out.unshift({ ...base, d });
    return out;
  }
  if (a.t === 'note') {
    return [{
      d: `M${r2(a.x - 6)} ${r2(a.y - 6)} L${r2(a.x + 6)} ${r2(a.y - 6)} Q${r2(a.x + 7.5)} ${r2(a.y - 6)} ${r2(a.x + 7.5)} ${r2(a.y - 4.5)}`
        + ` L${r2(a.x + 7.5)} ${r2(a.y + 2)} Q${r2(a.x + 7.5)} ${r2(a.y + 3.5)} ${r2(a.x + 6)} ${r2(a.y + 3.5)} L${r2(a.x - 0.5)} ${r2(a.y + 3.5)}`
        + ` L${r2(a.x - 4)} ${r2(a.y + 6.5)} L${r2(a.x - 4)} ${r2(a.y + 3.5)} L${r2(a.x - 6)} ${r2(a.y + 3.5)}`
        + ` Q${r2(a.x - 7.5)} ${r2(a.y + 3.5)} ${r2(a.x - 7.5)} ${r2(a.y + 2)} L${r2(a.x - 7.5)} ${r2(a.y - 4.5)} Q${r2(a.x - 7.5)} ${r2(a.y - 6)} ${r2(a.x - 6)} ${r2(a.y - 6)} Z`,
      stroke: null, fill: a.c, w: 0, op: 1, dash: null, ink: false,
    }];
  }
  return [];
}

export const NOTE_FONT = 8.5; // points
const noteLines = (a) => String(a.str || ' ').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 38)), 0);
export const noteWidth = (a) => Math.min(190, Math.max(60, Math.max(...String(a.str || ' ').split('\n').map((l) => l.length)) * NOTE_FONT * 0.55 + 14));
export const noteHeight = (a) => noteLines(a) * NOTE_FONT * 1.3 + 8;
/** Height of a text box, estimated from its text (the box wraps at `bw`). */
export function tboxHeight(a) {
  const per = Math.max(1, Math.floor((a.bw - 4) / (a.s * 0.52)));
  const lines = String(a.str || ' ').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / per)), 0);
  return lines * a.s * 1.25 + 4;
}

/** The mark's text, for the export: [{ str, x, y, size, color, width, box }]
 *  (`y` is the TOP of the first line; `box` = draw a tinted card behind). */
export function markTexts(a) {
  if (a.t === 'note' && a.str) {
    return [{ str: a.str, x: a.x + 13, y: a.y - 4, size: NOTE_FONT, color: '#1d1d1f', width: noteWidth(a) - 6, box: a.c }];
  }
  if (a.t === 'tbox' && a.str) return [{ str: a.str, x: a.x + 2, y: a.y + 2, size: a.s, color: a.c, width: a.bw - 4, box: null }];
  if (a.t === 'text' && a.str) return [{ str: a.str, x: a.x, y: a.y - a.s, size: a.s, color: a.c, width: 9999, box: null }];
  return [];
}

/** Is (x, y) on a comment's ICON (not on its text)? A click there folds the
 *  comment away or brings its text back. */
export const onNoteIcon = (a, x, y) => a.t === 'note' && Math.abs(x - a.x) <= 8.5 && Math.abs(y - a.y) <= 7.5;

/* ---------- selections of text ---------- */

/** The rectangles of a text selection ([x, y, w, h], points) merged into one
 *  per line: a selection gives one box per text run, and highlighting each
 *  separately left darker seams where they overlap. */
export function mergeLineRects(rects) {
  // Left to right: runs of one line sit at slightly different heights (a
  // different font, a sub/superscript), so sorting by y would interleave them.
  const rs = rects.filter((r) => r[2] > 0.3 && r[3] > 0.3).map((r) => [...r]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of rs) {
    const line = out.find((o) => {
      const top = Math.max(o[1], r[1]);
      const bottom = Math.min(o[1] + o[3], r[1] + r[3]);
      return bottom - top > 0.5 * Math.min(o[3], r[3]) && r[0] - (o[0] + o[2]) < 0.8 * Math.max(o[3], r[3]);
    });
    if (!line) { out.push(r); continue; }
    const x0 = Math.min(line[0], r[0]);
    const y0 = Math.min(line[1], r[1]);
    const x1 = Math.max(line[0] + line[2], r[0] + r[2]);
    const y1 = Math.max(line[1] + line[3], r[1] + r[3]);
    line.splice(0, 4, x0, y0, x1 - x0, y1 - y0);
  }
  return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]).map((r) => r.map(r2));
}

/* ---------- boxes and hits ---------- */

/** Bounding box [x0, y0, x1, y1] of a mark (for hit testing and selection). */
export function bbox(a) {
  const pad = (a.w || 0) / 2;
  if (a.pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 1 < a.pts.length; i += 2) {
      x0 = Math.min(x0, a.pts[i]); x1 = Math.max(x1, a.pts[i]);
      y0 = Math.min(y0, a.pts[i + 1]); y1 = Math.max(y1, a.pts[i + 1]);
    }
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  }
  if (a.rects) {
    const xs = a.rects.flatMap((r) => [r[0], r[0] + r[2]]);
    const ys = a.rects.flatMap((r) => [r[1], r[1] + r[3]]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (a.t === 'note') {
    // Folded (or still empty): only the icon is there to be hit.
    return a.closed || !a.str ? [a.x - 7.5, a.y - 6, a.x + 7.5, a.y + 6.5]
      : [a.x - 7, a.y - 7, a.x + 7 + noteWidth(a), a.y + noteHeight(a)];
  }
  if (a.t === 'tbox') return [a.x, a.y, a.x + a.bw, a.y + tboxHeight(a)];
  if (a.t === 'text') return [a.x, a.y - a.s, a.x + a.str.length * a.s * 0.6, a.y + a.s * 0.3];
  if (a.t === 'line' || a.t === 'arrow') {
    const pts = linePoints(a);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
  }
  return [Math.min(a.x0, a.x1) - pad, Math.min(a.y0, a.y1) - pad, Math.max(a.x0, a.x1) + pad, Math.max(a.y0, a.y1) + pad];
}

function distToSeg(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}
/** Is (x, y) on the mark, within `tol` points? */
export function hitTest(a, x, y, tol) {
  if (a.pts) {
    for (let i = 0; i + 3 < a.pts.length; i += 2) {
      if (distToSeg(x, y, a.pts[i], a.pts[i + 1], a.pts[i + 2], a.pts[i + 3]) <= tol + a.w / 2) return true;
    }
    return a.pts.length >= 2 && Math.hypot(x - a.pts[0], y - a.pts[1]) <= tol + a.w / 2;
  }
  if (a.rects) return a.rects.some((r) => x >= r[0] - tol && x <= r[0] + r[2] + tol && y >= r[1] - tol && y <= r[1] + r[3] + tol);
  if (a.t === 'line' || a.t === 'arrow') {
    const pts = linePoints(a);
    for (let i = 0; i + 1 < pts.length; i++) {
      if (distToSeg(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) <= tol + a.w / 2) return true;
    }
    return false;
  }
  if (a.t === 'rect') {
    const [lx, ty, rx, by] = [Math.min(a.x0, a.x1), Math.min(a.y0, a.y1), Math.max(a.x0, a.x1), Math.max(a.y0, a.y1)];
    const nearV = x >= lx - tol && x <= rx + tol;
    const nearH = y >= ty - tol && y <= by + tol;
    return (nearH && (Math.abs(x - lx) <= tol || Math.abs(x - rx) <= tol))
      || (nearV && (Math.abs(y - ty) <= tol || Math.abs(y - by) <= tol));
  }
  if (a.t === 'ellipse') {
    const cx = (a.x0 + a.x1) / 2, cy = (a.y0 + a.y1) / 2;
    const rx = Math.max(0.5, Math.abs(a.x1 - a.x0) / 2), ry = Math.max(0.5, Math.abs(a.y1 - a.y0) / 2);
    return Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry) <= tol + a.w / 2;
  }
  const b = bbox(a);
  return x >= b[0] - tol && x <= b[2] + tol && y >= b[1] - tol && y <= b[3] + tol;
}

export function moveMark(a, dx, dy) {
  // Rounded as it goes: a drag is hundreds of tiny steps, and their float
  // dust (379.99999999999994) would be saved with the mark.
  if (a.pts) for (let i = 0; i + 1 < a.pts.length; i += 2) { a.pts[i] = r2(a.pts[i] + dx); a.pts[i + 1] = r2(a.pts[i + 1] + dy); }
  else if (a.rects) for (const r of a.rects) { r[0] = r2(r[0] + dx); r[1] = r2(r[1] + dy); }
  else if ('x0' in a) {
    a.x0 = r2(a.x0 + dx); a.x1 = r2(a.x1 + dx); a.y0 = r2(a.y0 + dy); a.y1 = r2(a.y1 + dy);
    if (a.mx != null) a.mx = r2(a.mx + dx);
    if (a.my != null) a.my = r2(a.my + dy);
  } else { a.x = r2(a.x + dx); a.y = r2(a.y + dy); }
}

/* ---------- editing a mark by its handles ---------- */

/** (x, y) seen from (ox, oy), locked to the nearest multiple of 45°. */
export function snapAngle(ox, oy, x, y) {
  const dx = x - ox, dy = y - oy;
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
  return [ox + len * Math.cos(ang), oy + len * Math.sin(ang)];
}

const BOX_IDS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
/** The handles a selected mark is edited by: [{ id, x, y }]. A line has its
 *  two ends and its middle (drag it to bend the line); shapes and strokes
 *  have the eight of their box; a text box its two sides. */
export function handlesOf(a) {
  if (a.t === 'line' || a.t === 'arrow') {
    const [mx, my] = lineMid(a);
    return [{ id: 'p0', x: a.x0, y: a.y0 }, { id: 'p1', x: a.x1, y: a.y1 }, { id: 'mid', x: mx, y: my }];
  }
  if (a.t === 'tbox') {
    const h = tboxHeight(a);
    return [{ id: 'w', x: a.x, y: a.y + h / 2 }, { id: 'e', x: a.x + a.bw, y: a.y + h / 2 }];
  }
  if (a.t === 'rect' || a.t === 'ellipse' || a.t === 'pen' || a.t === 'highlight') {
    const pad = a.pts ? (a.w || 0) / 2 : 0;
    const [x0, y0, x1, y1] = a.pts ? bbox(a).map((v, i) => (i < 2 ? v + pad : v - pad))
      : [Math.min(a.x0, a.x1), Math.min(a.y0, a.y1), Math.max(a.x0, a.x1), Math.max(a.y0, a.y1)];
    const xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
    const at = { nw: [x0, y0], n: [xm, y0], ne: [x1, y0], e: [x1, ym], se: [x1, y1], s: [xm, y1], sw: [x0, y1], w: [x0, ym] };
    return BOX_IDS.map((id) => ({ id, x: at[id][0], y: at[id][1] }));
  }
  return [];
}

/** Move handle `id` of `a` to (x, y). `orig` is a copy of the mark as it was
 *  when the drag began (every step is computed from it, so nothing drifts).
 *  `shift` locks a line's end to 0°/45°/90° and keeps a box's proportions. */
export function applyHandle(a, id, x, y, orig, shift) {
  if (a.t === 'line' || a.t === 'arrow') {
    if (id === 'p0' || id === 'p1') {
      const end = id === 'p0' ? ['x0', 'y0', 'x1', 'y1'] : ['x1', 'y1', 'x0', 'y0'];
      let nx = x, ny = y;
      if (shift) [nx, ny] = snapAngle(orig[end[2]], orig[end[3]], x, y);
      // The middle of a curve follows half-way, so the bend keeps its feel.
      if (orig.kind === 'curve' && orig.mx != null) {
        a.mx = orig.mx + (nx - orig[end[0]]) / 2;
        a.my = orig.my + (ny - orig[end[1]]) / 2;
      }
      a[end[0]] = r2(nx); a[end[1]] = r2(ny);
      return;
    }
    if (a.kind === 'elbow') {
      if (a.el === 'v') a.my = r2(y); else a.mx = r2(x);
      return;
    }
    // The middle: pull it off the chord and the line bends; put it back
    // (or hold Shift) and it is straight again.
    const cx = (a.x0 + a.x1) / 2, cy = (a.y0 + a.y1) / 2;
    const len = Math.hypot(a.x1 - a.x0, a.y1 - a.y0) || 1;
    const off = Math.abs((x - a.x0) * (a.y1 - a.y0) - (y - a.y0) * (a.x1 - a.x0)) / len;
    if (shift || (off < Math.max(1.5, len * 0.02) && Math.hypot(x - cx, y - cy) < len * 0.25)) {
      delete a.kind; delete a.mx; delete a.my;
    } else {
      a.kind = 'curve'; a.mx = r2(x); a.my = r2(y);
    }
    return;
  }
  if (a.t === 'tbox') {
    if (id === 'e') a.bw = r2(Math.max(30, x - orig.x));
    else { const nx = Math.min(x, orig.x + orig.bw - 30); a.bw = r2(orig.x + orig.bw - nx); a.x = r2(nx); }
    return;
  }
  // The eight handles of a box.
  const pad = orig.pts ? (orig.w || 0) / 2 : 0;
  const ob = orig.pts ? bbox(orig).map((v, i) => (i < 2 ? v + pad : v - pad))
    : [Math.min(orig.x0, orig.x1), Math.min(orig.y0, orig.y1), Math.max(orig.x0, orig.x1), Math.max(orig.y0, orig.y1)];
  let [x0, y0, x1, y1] = ob;
  if (id.includes('w')) x0 = x;
  if (id.includes('e')) x1 = x;
  if (id.includes('n')) y0 = y;
  if (id.includes('s')) y1 = y;
  if (shift && id.length === 2) {
    // A corner with Shift keeps the proportions the box had.
    const ow = (ob[2] - ob[0]) || 1, oh = (ob[3] - ob[1]) || 1;
    const k = Math.max(Math.abs(x1 - x0) / ow, Math.abs(y1 - y0) / oh);
    if (id.includes('w')) x0 = x1 - Math.sign(x1 - x0 || 1) * ow * k; else x1 = x0 + Math.sign(x1 - x0 || 1) * ow * k;
    if (id.includes('n')) y0 = y1 - Math.sign(y1 - y0 || 1) * oh * k; else y1 = y0 + Math.sign(y1 - y0 || 1) * oh * k;
  }
  if (a.pts) {
    const sx = ob[2] - ob[0] > 1e-6 ? (x1 - x0) / (ob[2] - ob[0]) : 1;
    const sy = ob[3] - ob[1] > 1e-6 ? (y1 - y0) / (ob[3] - ob[1]) : 1;
    for (let i = 0; i + 1 < orig.pts.length; i += 2) {
      a.pts[i] = r2(x0 + (orig.pts[i] - ob[0]) * sx);
      a.pts[i + 1] = r2(y0 + (orig.pts[i + 1] - ob[1]) * sy);
    }
    return;
  }
  a.x0 = r2(x0); a.y0 = r2(y0); a.x1 = r2(x1); a.y1 = r2(y1);
}

/* ---------- the eraser that removes only what it touches ---------- */

/** A shape's outline as a stroke the eraser can cut (flat points), or null
 *  for what is erased whole or not at all (arrows, text, comments). */
function outlineOf(a) {
  if (a.pts) return a.pts;
  if (a.t === 'line') return flat(linePoints(a));
  if (a.t === 'rect') {
    const [x0, y0, x1, y1] = [Math.min(a.x0, a.x1), Math.min(a.y0, a.y1), Math.max(a.x0, a.x1), Math.max(a.y0, a.y1)];
    return [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
  }
  if (a.t === 'ellipse') {
    const cx = (a.x0 + a.x1) / 2, cy = (a.y0 + a.y1) / 2, rx = Math.abs(a.x1 - a.x0) / 2, ry = Math.abs(a.y1 - a.y0) / 2;
    const out = [];
    for (let i = 0; i <= 72; i++) { const t = (i / 72) * 2 * Math.PI; out.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t)); }
    return out;
  }
  return null;
}
/** Points no farther apart than `step`, so a cut lands where the eraser is
 *  and not at the next recorded point of a long straight stretch. */
function densify(p, step) {
  const out = [p[0], p[1]];
  for (let i = 2; i + 1 < p.length; i += 2) {
    const x0 = p[i - 2], y0 = p[i - 1], x1 = p[i], y1 = p[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = 1; k <= n; k++) out.push(x0 + (x1 - x0) * (k / n), y0 + (y1 - y0) * (k / n));
  }
  return out;
}

/** Erase what lies within `r` points of (x, y) from the marks `arr`.
 *  `whole` = a touched mark goes entirely. Otherwise strokes, lines,
 *  rectangles and ellipses lose only the touched part (what remains becomes
 *  plain strokes); arrows, text and comments are left alone — they are
 *  removed whole, with the other eraser or with Supr.
 *  Returns the new array, or null when nothing was touched. */
export function eraseAt(arr, x, y, r, whole) {
  let changed = false;
  const out = [];
  for (const a of arr) {
    if (whole) {
      if (hitTest(a, x, y, r)) { changed = true; continue; }
      out.push(a);
      continue;
    }
    const line = a.t === 'mark' || a.t === 'arrow' || a.t === 'note' || a.t === 'tbox' || a.t === 'text' ? null : outlineOf(a);
    if (!line || !hitTest(a, x, y, r)) { out.push(a); continue; }
    const reach = r + (a.w || 0) / 2;
    const p = densify(line, Math.max(0.75, r / 2));
    const runs = [];
    let run = [];
    for (let i = 0; i + 1 < p.length; i += 2) {
      if (Math.hypot(p[i] - x, p[i + 1] - y) <= reach) {
        if (run.length >= 4) runs.push(run);
        run = [];
      } else run.push(r2(p[i]), r2(p[i + 1]));
    }
    if (run.length >= 4) runs.push(run);
    changed = true;
    // What is left keeps the mark's look: ink stays smooth, a cut shape keeps
    // its straight sides and corners.
    const isInk = a.t === 'pen' || a.t === 'highlight';
    for (const pts of runs) {
      const piece = { t: a.t === 'highlight' ? 'highlight' : 'pen', c: a.c, w: a.w, pts };
      if (!isInk || a.poly) piece.poly = true;
      if (a.dash) piece.dash = true;
      out.push(piece);
    }
  }
  return changed ? out : null;
}
