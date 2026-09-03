// PDF preview (PDF.js), virtualized for documents of ANY size.
//
// PERFORMANCE CONTRACT — read this before touching the layout code.
//
// The viewer must stay fluid on a 7 000-page report. Two rules make that work,
// and breaking either one brings back the freeze:
//
//  1. GEOMETRY IS ARITHMETIC, NEVER MEASURED. Page positions come from a prefix
//     sum over the page heights (`tops[]`), and "which page is at y?" is a
//     bisect. The old viewer walked all N pages reading `offsetTop` on every
//     scroll frame — and every one of those reads forces the browser to flush
//     layout, so scrolling a big document meant thousands of synchronous
//     layout passes per second.
//
//  2. ONLY VISIBLE PAGES EXIST IN THE DOM. Pages are absolutely positioned
//     inside a single sizer div whose height is the whole document; the ones
//     outside the viewport are not placeholder divs, they are *nothing*. The
//     old viewer created N page divs up front and rewrote the inline width and
//     height of every one of them on each zoom tick — 7 000 style writes per
//     wheel notch.
//
// The upshot: scrolling and zooming cost O(visible pages), not O(document).
//
// Everything else is unchanged: cursor-anchored Ctrl/right-wheel zoom, pinch,
// the circular loupe, select/pan tools, a selectable text layer, clickable
// links and SyncTeX both ways.

import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { readBinaryFile, openExternal, synctexEdit, pathExists, emitToWindow } from '../core/platform.js';
import { baseName } from '../core/paths.js';
import { buildPathToSource } from '../compile/build-maps.js';
import { setAnnotDoc, buildAnnotLayer } from './annotate.js';
import { general } from '../solid/stores/settingsStore.js';
import {
  getScale, setScale, getFitMode, setFitMode,
  setNumPages, setCurrentPage, setPreviewFile, setHasPdf, tool, setLastArea,
  setLoadError, setSearchProgress,
} from '../solid/stores/previewStore.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

let container = null;      // the scrolling element
let sizer = null;          // single child; its height IS the document height
let pdfDoc = null;
let currentBytes = null;
let currentPath = null;
let loadedPath = null;     // path of the document currently laid out (see openDoc)

/* ---------- page geometry (the whole layout model) ----------
   baseW/baseH are per-page sizes at scale 1 (PDF points). `tops` is a prefix
   sum of the laid-out page heights at the CURRENT scale, with one extra entry
   holding the total height. Nothing here is ever measured from the DOM. */
let baseW = [];            // per page, scale-1 width
let baseH = [];            // per page, scale-1 height
let tops = [0];            // tops[i] = y of page i; tops[n] = total height
let innerW = 0;            // sizer width at the current scale
let padTop = 0, padX = 0, padY = 0;

const mounted = new Map(); // page index -> wrap element (ONLY the visible ones)

let renderSeq = 0;         // bumped to cancel in-flight page renders
let scrollRaf = 0;
let resizeObs = null;
let lastWidth = 0;
let resizeTimer = null;

const GAP = 14;            // vertical space between pages — must match the CSS
const BUFFER = 0.8;        // viewport-heights rendered beyond the view
const KEEP = 2;            // extra mounted pages kept each side (scroll slack)

function dpr() { return Math.max(1, window.devicePixelRatio || 1); }
// Pages always re-rasterize at the EXACT current scale × density, so the page is
// effectively vector-sharp at every zoom. Manual zoom is capped at 400%.
function clampScale(s) { return Math.max(0.1, Math.min(4, +s.toFixed(3))); }

const pageCount = () => baseW.length;
const pageWpx = (i) => Math.floor(baseW[i] * getScale());
const pageHpx = (i) => Math.floor(baseH[i] * getScale());
const totalH = () => tops[pageCount()] || 0;

function readPadding() {
  if (!container) return;
  const cs = getComputedStyle(container);
  padTop = parseFloat(cs.paddingTop) || 0;
  padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  padY = padTop + (parseFloat(cs.paddingBottom) || 0);
}

/** Recompute every page's position from the page sizes and the current scale.
 *  O(n) in cheap arithmetic (no DOM touched), so it's fine on every zoom tick:
 *  7 000 pages is a few thousand additions — microseconds. */
function recomputeGeometry() {
  const n = pageCount();
  if (!n || !container || !sizer) return;
  let maxW = 0;
  for (let i = 0; i < n; i++) {
    const w = pageWpx(i);
    if (w > maxW) maxW = w;
  }
  // The sizer is at least as wide as the viewport, so narrow pages centre and
  // wide ones stay fully scrollable to their left edge.
  const availW = Math.max(0, container.clientWidth - padX);
  innerW = Math.max(maxW, availW);

  tops = new Array(n + 1);
  let y = 0;
  for (let i = 0; i < n; i++) {
    tops[i] = y;
    y += pageHpx(i) + GAP;
  }
  tops[n] = Math.max(0, y - GAP); // no trailing gap

  sizer.style.width = innerW + 'px';
  sizer.style.height = tops[n] + 'px';
}

/** Index of the last page whose top is at or above `y` (document coords, i.e.
 *  excluding the container's top padding). Bisect — this is the hot path. */
function indexAtY(y) {
  const n = pageCount();
  if (!n) return -1;
  if (y <= 0) return 0;
  let lo = 0, hi = n - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] <= y) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/** [first, last] page indices to keep mounted, from the scroll position. */
function visibleRange() {
  const n = pageCount();
  if (!n || !container) return [0, -1];
  const view = container.clientHeight;
  const y = container.scrollTop - padTop;
  const first = indexAtY(y - view * BUFFER);
  const last = indexAtY(y + view * (1 + BUFFER));
  return [Math.max(0, first), Math.min(n - 1, Math.max(first, last))];
}

/* ---------- DOM windowing ---------- */
function makeWrap(i) {
  const wrap = document.createElement('div');
  wrap.className = 'pdf-page';
  wrap.dataset.page = String(i + 1);
  wrap.dataset.rscale = '';
  return wrap;
}

/** Place a mounted page at its computed slot. */
function placeWrap(i, wrap) {
  const w = pageWpx(i), h = pageHpx(i);
  wrap.style.left = Math.round((innerW - w) / 2) + 'px';
  wrap.style.top = tops[i] + 'px';
  wrap.style.width = w + 'px';
  wrap.style.height = h + 'px';
  // GPU-stretch the raster we already have to the new size (instant, never
  // blank); renderVisible then re-rasterizes it crisply at the exact scale.
  const content = wrap.firstChild;
  const rs = parseFloat(wrap.dataset.rscale || '0');
  if (content && rs) {
    const s = getScale();
    content.style.transformOrigin = '0 0';
    content.style.transform = rs === s ? '' : `scale(${s / rs})`;
  }
}

/** Mount the pages in the window, drop the ones that left it, and reposition
 *  what stays. O(visible), never O(document). */
function syncWindow() {
  if (!sizer || !pageCount()) return [0, -1];
  const [lo, hi] = visibleRange();
  for (const [i, el] of mounted) {
    if (i < lo - KEEP || i > hi + KEEP) {
      el.remove();
      mounted.delete(i);
    }
  }
  for (let i = lo; i <= hi; i++) {
    if (mounted.has(i)) continue;
    const wrap = makeWrap(i);
    mounted.set(i, wrap);
    sizer.appendChild(wrap);
  }
  for (const [i, el] of mounted) placeWrap(i, el);
  return [lo, hi];
}

export function setPreviewContainer(el) {
  // The preview pane unmounts/remounts (maximize viewer, hide/show preview,
  // closing the detached window). The mounted page nodes belong to the OLD
  // container's DOM, so on a NEW element they must be dropped.
  if (container !== el) {
    mounted.clear();
    sizer = null;
  }
  container = el;
  readPadding();
  // Events must attach to EVERY new container element, not once per module.
  attachEvents(el);
  if (resizeObs) resizeObs.disconnect();
  lastWidth = el.clientWidth;
  resizeObs = new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - lastWidth) < 2) return;
    lastWidth = container.clientWidth;
    if (getFitMode() === 'none') { recomputeGeometry(); scheduleVisible(); return; }
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { fitToView(); renderVisible(); }, 120);
  });
  resizeObs.observe(el);
  if (currentBytes) openDoc();
}

export async function loadPdf(path) {
  try {
    currentPath = path;
    currentBytes = await readBinaryFile(path);
    setPreviewFile(baseName(path));
    await openDoc();
    setLoadError('');
  } catch (e) {
    // Never a silent blank pane: the viewer shows WHY the PDF didn't load.
    setLoadError(`No se pudo cargar el PDF: ${String((e && e.message) || e)}`);
    throw e;
  }
}
export function getPdfPath() { return currentPath; }

async function openDoc() {
  if (!currentBytes || !container) return;
  // A RECOMPILE of the document you're reading must not jump the view — but
  // OPENING a different document must start at page one. Keying off the path
  // (not the page count) gets both right.
  const sameDoc = currentPath === loadedPath && pageCount() > 0;
  const keepTop = sameDoc ? container.scrollTop : 0;
  const keepLeft = sameDoc ? container.scrollLeft : 0;
  const bytes = currentBytes.slice();
  const prev = pdfDoc;
  cancelTextIndex();          // new document → drop the search index
  pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  if (prev) { try { await prev.destroy(); } catch (_) {} }

  const n = pdfDoc.numPages;
  const samePageCount = n === pageCount();
  setNumPages(n);
  setHasPdf(true);

  // Size every page from page 1 — parsing all N pages up front would itself
  // take minutes on a huge document. Each page corrects its own size when it
  // first renders (see renderPage), so mixed-format documents self-heal.
  const p1 = await pdfDoc.getPage(1);
  const vp = p1.getViewport({ scale: 1 });
  baseW = new Array(n).fill(vp.width);
  baseH = new Array(n).fill(vp.height);
  setAnnotDoc(currentPath, vp.width, vp.height); // load this PDF's saved annotations

  renderSeq++;
  if (!sizer || sizer.parentElement !== container) {
    sizer = document.createElement('div');
    sizer.className = 'pdf-sizer';
    container.replaceChildren(sizer);
    mounted.clear();
  } else if (samePageCount) {
    // NO blank flash on recompiles: keep the pages on screen and let each swap
    // to its new raster the moment it finishes (renderPage replaces atomically).
    for (const wrap of mounted.values()) wrap.dataset.rscale = '';
  } else {
    sizer.replaceChildren();
    mounted.clear();
  }

  // Establish a VALID geometry before any fit math runs — applyFit asks which
  // page is on screen, and that answer comes from `tops`.
  tops = new Array(n + 1).fill(0);
  recomputeGeometry();
  applyFit();
  recomputeGeometry();
  // Second fit pass: laying the pages out may have shown a scrollbar, which
  // changes the available size — re-fit so the page lands exactly.
  if (getFitMode() !== 'none') { applyFit(); recomputeGeometry(); }

  // Set the scroll position LAST, once the geometry is final: a new document
  // opens at the top, a recompile stays where you were reading.
  container.scrollTop = keepTop;
  container.scrollLeft = keepLeft;
  loadedPath = currentPath;
  setCurrentPage(currentVisiblePage());
  renderVisible();
}

function applyFit() {
  const mode = getFitMode();
  if (mode === 'none' || !pageCount() || !container) return;
  // Measure the REAL available area: client size minus the actual padding
  // (clientWidth already excludes the scrollbar).
  const availW = Math.max(100, container.clientWidth - padX - 2);
  const availH = Math.max(100, container.clientHeight - padY - 2);
  // Fit against the page under the cursor, so fitting inside a mixed-size
  // document uses the page you're actually looking at.
  const i = Math.max(0, Math.min(pageCount() - 1, currentVisiblePage() - 1));
  const w = baseW[i], h = baseH[i];
  let s = getScale();
  if (mode === 'width') s = availW / w;
  else if (mode === 'height') s = availH / h;
  else if (mode === 'page') s = Math.min(availW / w, availH / h);
  else if (mode === 'text') s = availW / (w * 0.74);
  setScale(clampScale(s));
}

// Robust fit: TWO passes. The first fit may add or remove a scrollbar, which
// changes the available width/height; the second reads the corrected client
// size, so the page lands EXACTLY in the fit axis with no leftover scrollbar.
function fitToView() {
  if (getFitMode() === 'none') return;
  applyFit(); recomputeGeometry();
  applyFit(); recomputeGeometry();
  syncWindow();
}

async function renderVisible() {
  if (!pdfDoc || !pageCount()) return;
  const seq = renderSeq;
  const s = getScale();
  const [lo, hi] = syncWindow();
  if (hi < lo) return;

  for (let i = lo; i <= hi; i++) {
    if (seq !== renderSeq) return;
    const wrap = mounted.get(i);
    if (!wrap || wrap.dataset.rscale === String(s)) continue;
    await renderPage(i + 1, wrap, s, seq);
  }
  setCurrentPage(currentVisiblePage());
}

async function renderPage(n, wrap, s, seq) {
  const page = await pdfDoc.getPage(n);
  if (seq !== renderSeq || !mounted.has(n - 1)) return; // scrolled away meanwhile
  const vp = page.getViewport({ scale: s });

  // First sight of this page's REAL size: if it isn't what we assumed from page
  // 1, correct the model and re-lay-out. Keep the reading position anchored so
  // the correction never yanks the view.
  const realW = vp.width / s, realH = vp.height / s;
  if (Math.abs(realW - baseW[n - 1]) > 0.5 || Math.abs(realH - baseH[n - 1]) > 0.5) {
    const anchor = topAnchor();
    baseW[n - 1] = realW;
    baseH[n - 1] = realH;
    recomputeGeometry();
    restoreTopAnchor(anchor);
    for (const [i, el] of mounted) placeWrap(i, el);
  }

  // Rasterize at EXACTLY the device resolution (1 canvas pixel = 1 screen
  // pixel). Supersampling forced the browser to MINIFY the canvas, and bilinear
  // minification skips texels — hairlines (0.4–0.5pt header/footer rules) landed
  // between samples and faded out. Device-exact rendering keeps every rule crisp
  // (TeXstudio behaviour); zoom sharpness is unaffected because pages
  // re-rasterize at the exact scale after every zoom.
  let os = dpr();
  const cap = 12288;
  if (vp.width * os > cap || vp.height * os > cap) os = Math.min(cap / vp.width, cap / vp.height);

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width * os);
  canvas.height = Math.round(vp.height * os);
  // Integer backing ↔ device pixels: the CSS size derives from the backing so
  // the mapping stays exactly 1:1 and the browser never resamples the raster.
  canvas.style.width = canvas.width / os + 'px';
  canvas.style.height = canvas.height / os + 'px';

  const ctx = canvas.getContext('2d', { alpha: false });
  try {
    await page.render({ canvasContext: ctx, viewport: vp, transform: os !== 1 ? [os, 0, 0, os, 0, 0] : null }).promise;
  } catch (_) { return; }
  if (seq !== renderSeq || !mounted.has(n - 1)) return;

  // Canvas + text layer live in one content div so the zoom relayout can
  // GPU-stretch them together while the crisp re-render is in flight.
  const content = document.createElement('div');
  content.className = 'pdf-page-content';
  content.appendChild(canvas);
  wrap.replaceChildren(content);
  try { buildTextLayer(page, vp, content); } catch (_) {}
  try { await buildLinkLayer(page, vp, content); } catch (_) {}
  try { buildAnnotLayer(n, content); } catch (_) {}
  wrap.dataset.rscale = String(s);
}

/* ---------- scroll anchoring (used when geometry shifts under us) ---------- */
function topAnchor() {
  if (!container || !pageCount()) return null;
  const y = container.scrollTop - padTop;
  const i = indexAtY(y);
  const h = pageHpx(i) || 1;
  return { i, frac: (y - tops[i]) / h };
}
function restoreTopAnchor(a) {
  if (!a || !container || a.i >= pageCount()) return;
  container.scrollTop = padTop + tops[a.i] + a.frac * pageHpx(a.i);
}

/* ---------- clickable PDF links (TOC, \ref, \url — like TeXstudio) ---------- */
async function buildLinkLayer(page, vp, content) {
  const annots = await page.getAnnotations();
  const links = annots.filter((a) => a.subtype === 'Link' && (a.url || a.dest));
  if (!links.length) return;
  const layer = document.createElement('div');
  layer.className = 'pdf-linklayer';
  for (const a of links) {
    // Two convertToViewportPoint calls (stable across PDF.js versions) instead
    // of the deprecated convertToViewportRectangle.
    const p1 = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
    const p2 = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
    const x1 = Math.min(p1[0], p2[0]), y1 = Math.min(p1[1], p2[1]);
    const x2 = Math.max(p1[0], p2[0]), y2 = Math.max(p1[1], p2[1]);
    const el = document.createElement('a');
    el.className = 'pdf-link';
    el.style.left = x1 + 'px';
    el.style.top = y1 + 'px';
    el.style.width = (x2 - x1) + 'px';
    el.style.height = (y2 - y1) + 'px';
    if (a.url) el.title = a.url;
    el.addEventListener('click', (e) => {
      if (e.ctrlKey) return; // Ctrl+click = SyncTeX jump to source, not the link
      e.preventDefault();
      e.stopPropagation();
      if (a.url) openExternal(a.url);
      else goToDest(a.dest);
    });
    layer.appendChild(el);
  }
  content.appendChild(layer);
}

// Navigate to an internal destination (page + vertical position).
async function goToDest(dest) {
  if (!pdfDoc) return;
  try {
    const d = typeof dest === 'string' ? await pdfDoc.getDestination(dest) : dest;
    if (!d || d[0] == null) return;
    // d[0] is usually a page Ref ({num, gen}); some producers (xdvipdfmx, the
    // xelatex backend) emit a plain 0-based page NUMBER instead. The official
    // PDF.js viewer handles both — so do we, or TOC clicks die silently.
    const idx = typeof d[0] === 'number' ? d[0] : await pdfDoc.getPageIndex(d[0]);
    if (idx < 0 || idx >= pageCount()) return;
    let top = tops[idx];
    const kind = d[1] && d[1].name;
    // y is in PDF units measured from the BOTTOM of the page.
    const yPdf = kind === 'XYZ' ? d[3] : (kind === 'FitH' || kind === 'FitBH') ? d[2] : null;
    if (yPdf != null) {
      // Use the DESTINATION page's own height (documents can mix A4/A3,
      // portrait/landscape) — another page's height lands wrong.
      const pageH = baseH[idx];
      if (pageH) top += Math.max(0, 1 - yPdf / pageH) * pageHpx(idx) - 8;
    }
    container.scrollTop = Math.max(0, padTop + top);
    setCurrentPage(idx + 1);
    scheduleVisible();
  } catch (_) { /* malformed destination */ }
}

/* ---------- SyncTeX forward search: scroll to a source line's PDF spot ------ */

/* ---- exact-word flash in the PDF ----
   Both search directions mark the EXACT word, not the line: a Ctrl+click in
   the editor highlights the clicked word here, and a Ctrl+click on the PDF
   highlights it here too (while the editor selects it on its side).

   The highlight is an OVERLAY rectangle measured with a DOM Range over the
   text-layer node: `Range.getBoundingClientRect()` reports the word's real
   rendered box, including the span's scaleX correction — the same geometry
   native text selection paints. Wrapping the word in a nested <span> instead
   does NOT work: the text layer is laid out in a fallback font and then
   scaled, so an inline mark's own metrics land visibly off the glyphs. */

/** Highlight `word` on page `pageN` near vertical offset `yPx` (page-local
 *  CSS px), for a moment. The text layer builds asynchronously after the
 *  canvas, so this retries briefly. Returns true when the word was found. */
async function flashWordOnPage(pageN, yPx, word) {
  if (!word) return false;
  for (let tries = 0; tries < 12; tries++) {
    const wrap = mounted.get(pageN - 1);
    const layer = wrap && wrap.querySelector('.pdf-textlayer');
    if (layer && layer.childElementCount) {
      // The span vertically closest to the SyncTeX position that has the word.
      let best = null, bestD = Infinity;
      for (const s of layer.children) {
        if (s.textContent.toLowerCase().indexOf(word.toLowerCase()) < 0) continue;
        if (!s.firstChild || s.firstChild.nodeType !== 3) continue;
        const d = Math.abs(parseFloat(s.style.top || '0') - yPx);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (!best) return false;
      try {
        const node = best.firstChild;
        const i = best.textContent.toLowerCase().indexOf(word.toLowerCase());
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + word.length);
        const r = range.getBoundingClientRect();
        if (!r.width) return false;
        const w = wrap.getBoundingClientRect();
        container.querySelectorAll('.pdf-word-flash').forEach((m) => m.remove());
        const mark = document.createElement('div');
        mark.className = 'pdf-word-flash';
        mark.style.left = r.left - w.left - 2 + 'px';
        mark.style.top = r.top - w.top - 1 + 'px';
        mark.style.width = r.width + 4 + 'px';
        mark.style.height = r.height + 2 + 'px';
        wrap.appendChild(mark);
        setTimeout(() => mark.remove(), 2000);
        return true;
      } catch (_) { return false; }
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

// `page` is 1-based; x/y are PDF points from the page's TOP-LEFT corner (the
// synctex CLI convention). Scrolls there and marks the EXACT `word` when given
// (TeXstudio-style word precision); the line marker is the fallback.
export async function showPdfLocation(page, x, y, word) {
  if (!pdfDoc || page < 1 || page > pageCount()) return;
  const idx = page - 1;
  const pageH = baseH[idx] || 1;
  const frac = Math.max(0, Math.min(1, y / pageH));
  const yPx = frac * pageHpx(idx);
  container.scrollTop = Math.max(0, padTop + tops[idx] + yPx - container.clientHeight * 0.4);
  setCurrentPage(page);
  // Mount + render the target page NOW, then mark the word (or flash the line).
  await renderVisible();
  if (await flashWordOnPage(page, yPx, word)) return;
  const wrap = mounted.get(idx);
  if (!wrap) return;
  const flash = document.createElement('div');
  flash.className = 'pdf-fwd-flash';
  flash.style.top = Math.max(0, yPx - 9) + 'px';
  wrap.appendChild(flash);
  setTimeout(() => flash.remove(), 1400);
}

/* ---------- SyncTeX inverse search: Ctrl+click → exact source word ---------- */
// The word under a point in the text layer (so the jump can land on the EXACT
// clicked word, not just the line — SyncTeX's column is unreliable).
function wordAtPoint(clientX, clientY) {
  try {
    let node = null, offset = 0;
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(clientX, clientY);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(clientX, clientY);
      if (p) { node = p.offsetNode; offset = p.offset; }
    }
    if (!node || node.nodeType !== 3) return '';
    const text = node.textContent || '';
    const isW = (c) => c && /[\p{L}\p{N}]/u.test(c);
    let i = Math.min(offset, text.length - 1);
    if (i < 0) return '';
    if (!isW(text[i]) && i > 0 && isW(text[i - 1])) i--;
    if (!isW(text[i])) return '';
    let a = i, b = i + 1;
    while (a > 0 && isW(text[a - 1])) a--;
    while (b < text.length && isW(text[b])) b++;
    return text.slice(a, b);
  } catch (_) { return ''; }
}

async function synctexJump(pageNo, xPt, yPt, word) {
  if (!currentPath) return;
  try {
    const hit = await synctexEdit(currentPath, pageNo, xPt, yPt);
    // Keep the separators synctex reported. Rewriting them to backslashes made
    // inverse search a Windows-only feature: on macOS and Linux the resulting
    // path never existed, so Ctrl+click in the PDF silently did nothing.
    let p = String(hit.input || '');
    // The engine compiles the .build.tex copies, which live in the project's
    // WORKING DIRECTORY, outside the project. Map the reported path back to the
    // real source file. The build is CLEAN LaTeX (cells removed), so its line
    // numbers shift below every cell: translate through the compiler's map.
    const wasBuild = /\.build\.tex$/i.test(p);
    if (wasBuild) {
      const back = buildPathToSource(p);
      const stem = back ? `${back.dir}/${back.stem}` : p.replace(/\.build\.tex$/i, '');
      for (const cand of [stem + '.pltx', stem + '.tex']) {
        if (await pathExists(cand)) { p = cand; break; }
      }
    }
    let line = hit.line || 1;
    const column = typeof hit.column === 'number' ? hit.column : -1;
    // The detached viewer window has no editor (and no compile state): ask the
    // MAIN window to open the source at this spot — it translates build lines.
    if (typeof window !== 'undefined' && window.__PYX_VIEWER__) {
      emitToWindow('main', 'synctex:open', { path: p, line, column, word, buildLine: wasBuild });
      return;
    }
    const cmds = await import('../editor/commands.js');
    if (wasBuild) line = cmds.buildLineToSource(p, line);
    const docStore = await import('../solid/stores/docStore.js');
    await docStore.openPath(p);
    cmds.gotoLineCol(line, column, word);
  } catch (_) { /* synctex not available or no record at that point */ }
}

function buildTextLayer(page, vp, wrap) {
  page.getTextContent().then((tc) => {
    const layer = document.createElement('div');
    layer.className = 'pdf-textlayer';
    layer.style.width = vp.width + 'px';
    layer.style.height = vp.height + 'px';
    for (const item of tc.items) {
      if (!item.str) continue;
      const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
      const h = Math.hypot(tx[2], tx[3]);
      if (!h) continue;
      const span = document.createElement('span');
      span.textContent = item.str;
      span.style.left = tx[4] + 'px';
      span.style.top = tx[5] - h + 'px';
      span.style.fontSize = h + 'px';
      if (item.width) span.dataset.w = String(item.width * vp.scale);
      layer.appendChild(span);
    }
    wrap.appendChild(layer);
    // TWO passes: measure everything, then write everything.
    //
    // Reading `offsetWidth` forces the browser to flush pending layout. The
    // old loop read one span and immediately wrote its transform, invalidating
    // layout again for the next read — a full synchronous reflow per span, and
    // a dense page has thousands of them. Batching the reads means one layout
    // pass for the whole page.
    const spans = [...layer.children];
    const widths = new Array(spans.length);
    for (let i = 0; i < spans.length; i++) widths[i] = spans[i].offsetWidth;
    for (let i = 0; i < spans.length; i++) {
      const w = parseFloat(spans[i].dataset.w || '0');
      if (w && widths[i]) {
        spans[i].style.transform = `scaleX(${w / widths[i]})`;
        spans[i].style.transformOrigin = 'left top';
      }
    }
  });
}

/* ---------- controls ---------- */
export function setZoom(s) {
  setFitMode('none');
  setScale(clampScale(s));
  recomputeGeometry();
  renderVisible();
}
export function zoomBy(factor) {
  if (container) {
    const r = container.getBoundingClientRect();
    zoomAtPoint(factor, r.left + r.width / 2, r.top + r.height / 2);
  } else {
    setZoom(getScale() * factor);
  }
}
export function setFit(mode) {
  setFitMode(mode);
  const page = currentVisiblePage();
  fitToView();
  // Re-centre horizontally and keep the current page at the top of the view.
  container.scrollLeft = Math.max(0, (container.scrollWidth - container.clientWidth) / 2);
  if (mode === 'height') container.scrollTop = Math.max(0, padTop + tops[page - 1] - 8);
  renderVisible();
}
export function rerender() { recomputeGeometry(); renderVisible(); }
export function hasPdf() { return !!pdfDoc; }

// Anchor = which page is under the cursor + the fractional position inside it.
// Scale-independent, so zoom lands exactly under the mouse. Pure arithmetic:
// the old version scanned every page's offsetTop to find the one under the
// pointer, which on a big document forced a full layout on every wheel notch.
function buildAnchor(clientX, clientY) {
  if (!container || !pageCount()) return null;
  const rect = container.getBoundingClientRect();
  const offX = clientX - rect.left, offY = clientY - rect.top;
  const contentY = container.scrollTop + offY - padTop;
  const contentX = container.scrollLeft + offX;
  const i = indexAtY(contentY);
  if (i < 0) return null;
  const w = pageWpx(i), h = pageHpx(i);
  const left = Math.round((innerW - w) / 2);
  return {
    i,
    fx: w ? (contentX - left) / w : 0,
    fy: h ? (contentY - tops[i]) / h : 0,
    offX,
    offY,
  };
}
function applyAnchor(a) {
  if (!a || a.i >= pageCount()) return;
  const w = pageWpx(a.i), h = pageHpx(a.i);
  const left = Math.round((innerW - w) / 2);
  container.scrollLeft = left + a.fx * w - a.offX;
  container.scrollTop = padTop + tops[a.i] + a.fy * h - a.offY;
}

// Zoom keeping the point under the cursor fixed. The relayout + scroll fix are
// synchronous (the stretched raster shows instantly); the crisp re-render runs
// once the wheel settles, so rapid zooming never queues wasted renders.
let settleTimer = null;
function zoomAtPoint(factor, clientX, clientY) {
  if (!container) return;
  const old = getScale();
  const next = clampScale(old * factor);
  if (next === old) return;
  const anchor = buildAnchor(clientX, clientY);
  setFitMode('none');
  setScale(next);
  recomputeGeometry();
  syncWindow();
  if (anchor) applyAnchor(anchor);
  clearTimeout(settleTimer);
  // Re-rasterize quickly so the brief GPU-stretched (soft) frame is barely seen
  // and the page is sharp again almost immediately.
  settleTimer = setTimeout(() => renderVisible(), 70);
}

export function goToPage(n) {
  const i = Math.max(0, Math.min(pageCount() - 1, n - 1));
  if (!container || i < 0) return;
  container.scrollTop = Math.max(0, padTop + tops[i] - 8);
  setCurrentPage(i + 1);
  scheduleVisible();
}
export function goFirst() { goToPage(1); }
export function goLast() { if (pdfDoc) goToPage(pageCount()); }
export function goPrev() { goToPage(Math.max(1, currentVisiblePage() - 1)); }
export function goNext() { goToPage(Math.min(pageCount() || 1, currentVisiblePage() + 1)); }

/** The page occupying the middle of the viewport. Bisect, not a scan. */
function currentVisiblePage() {
  if (!container || !pageCount()) return 1;
  const mid = container.scrollTop + container.clientHeight / 2 - padTop;
  return indexAtY(mid) + 1;
}

function scheduleVisible() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    renderVisible();
    setCurrentPage(currentVisiblePage());
  });
}

/* ---------- events ---------- */
function attachEvents(el) {
  if (!el || el.__pyxEvents) return; // per-element guard (panes remount)
  el.__pyxEvents = true;

  // Interacting with the PDF makes it the search target (Ctrl+F).
  el.addEventListener('pointerdown', () => setLastArea('pdf'), { capture: true, passive: true });
  el.addEventListener('wheel', () => setLastArea('pdf'), { capture: true, passive: true });

  el.addEventListener('scroll', scheduleVisible, { passive: true });

  // Wheel handling:
  //  - Ctrl+wheel / pinch gesture (trackpads report pinch as ctrl+wheel) and
  //    right-button-held + wheel → zoom toward the cursor. The factor follows
  //    the delta magnitude, so trackpad pinch feels smooth and continuous.
  //  - Plain wheel / two-finger pan → DIRECT manual scrolling (1:1, no
  //    animated/automatic glide): like moving the page with your hand.
  el.addEventListener('wheel', (e) => {
    const rightHeld = (e.buttons & 2) === 2;
    if (e.ctrlKey || rightHeld) {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 0 ? 0.0022 : 0.05));
      zoomAtPoint(factor, e.clientX, e.clientY);
      return;
    }
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
    el.scrollTop += e.deltaY * k;
    el.scrollLeft += e.deltaX * k;
  }, { passive: false });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });

  // Touchscreen pinch zoom: track two touch pointers and zoom at their
  // midpoint (touch-action CSS lets the gestures reach us instead of the
  // browser's page zoom). Touchpad pinch arrives as ctrl+wheel (handled above).
  const touchPts = new Map();
  let pinchDist = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      touchPts.set(e.pointerId, [e.clientX, e.clientY]);
      pinchDist = 0;
    }
  }, { capture: true });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'touch' || !touchPts.has(e.pointerId)) return;
    touchPts.set(e.pointerId, [e.clientX, e.clientY]);
    if (touchPts.size === 2) {
      const [a, b] = [...touchPts.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinchDist) zoomAtPoint(dist / pinchDist, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      pinchDist = dist;
    }
  }, { capture: true });
  const endTouch = (e) => { touchPts.delete(e.pointerId); pinchDist = 0; };
  el.addEventListener('pointerup', endTouch, { capture: true });
  el.addEventListener('pointercancel', endTouch, { capture: true });

  // Pan (hand tool / middle button) and the loupe (magnifier tool or
  // double-click), held; release hides the loupe.
  let panning = false, sx = 0, sy = 0, sl = 0, st = 0;
  let lastDownT = 0, lastDownX = 0, lastDownY = 0, loupeUsedAt = 0;
  el.addEventListener('pointerdown', (e) => {
    // Ctrl+click → SyncTeX inverse search: open the source at this exact spot.
    if (e.button === 0 && e.ctrlKey) {
      const pageEl = e.target.closest && e.target.closest('.pdf-page');
      if (pageEl) {
        e.preventDefault();
        const r = pageEl.getBoundingClientRect();
        const word = wordAtPoint(e.clientX, e.clientY); // exact clicked word
        const idx = parseInt(pageEl.dataset.page, 10) - 1;
        // Mark the clicked word HERE too (the editor selects it on its side),
        // so both panes show exactly what was clicked — never just the line.
        if (word) flashWordOnPage(idx + 1, e.clientY - r.top, word);
        // Page size at scale 1 = PDF points (synctex units, top-left origin).
        synctexJump(
          idx + 1,
          ((e.clientX - r.left) / r.width) * baseW[idx],
          ((e.clientY - r.top) / r.height) * baseH[idx],
          word
        );
        return;
      }
    }
    const wantPan = e.button === 1 || (tool() === 'pan' && e.button === 0);
    if (wantPan) {
      e.preventDefault();
      panning = true;
      sx = e.clientX; sy = e.clientY; sl = el.scrollLeft; st = el.scrollTop;
      el.classList.add('panning');
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    }
    if (e.button !== 0) return;
    const now = performance.now();
    const isDbl = now - lastDownT < 400
      && Math.abs(e.clientX - lastDownX) < 6 && Math.abs(e.clientY - lastDownY) < 6;
    lastDownT = now; lastDownX = e.clientX; lastDownY = e.clientY;
    const onPage = e.target.closest && e.target.closest('.pdf-page');
    if (onPage && (tool() === 'magnify' || isDbl)) {
      e.preventDefault();
      loupeUsedAt = now;
      try { window.getSelection().removeAllRanges(); } catch (_) {}
      openLoupe();
      drawLoupe(e);
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
    }
  });
  el.addEventListener('dblclick', (e) => {
    if (performance.now() - loupeUsedAt < 600) {
      e.preventDefault();
      try { window.getSelection().removeAllRanges(); } catch (_) {}
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (panning) {
      el.scrollLeft = sl - (e.clientX - sx);
      el.scrollTop = st - (e.clientY - sy);
    } else if (loupe) {
      drawLoupe(e);
    }
  });
  const endInteract = (e) => {
    if (panning) { panning = false; el.classList.remove('panning'); }
    if (loupe) closeLoupe();
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  el.addEventListener('pointerup', endInteract);
  el.addEventListener('pointercancel', endInteract);

  // PDF → code selection sync (toggle in Configuración): selecting text in the
  // PDF selects the same word/phrase in the editor source (via SyncTeX + text).
  el.addEventListener('mouseup', () => {
    if (!general.selSyncPdfToCode) return;
    setTimeout(syncSelectionToCode, 0); // let the selection finalize
  });
}

function syncSelectionToCode() {
  if (!general.selSyncPdfToCode) return;
  const selObj = window.getSelection();
  if (!selObj || selObj.isCollapsed || !selObj.rangeCount) return;
  const text = selObj.toString().replace(/\s+/g, ' ').trim();
  if (!text || text.length > 120) return;
  const range = selObj.getRangeAt(0);
  let startEl = range.startContainer;
  if (startEl.nodeType === 3) startEl = startEl.parentElement;
  const pageEl = startEl && startEl.closest ? startEl.closest('.pdf-page') : null;
  if (!pageEl) return;
  const rect = range.getBoundingClientRect();
  const r = pageEl.getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  const idx = parseInt(pageEl.dataset.page, 10) - 1;
  synctexJump(
    idx + 1,
    ((rect.left - r.left) / r.width) * baseW[idx],
    ((rect.top - r.top) / r.height) * baseH[idx],
    text
  );
}

/* ---------- PDF text search (focus-aware Ctrl+F target) ----------
   Extracting a page's text means parsing it, so indexing a 7 000-page report is
   minutes of work. The old code did it in ONE synchronous-ish loop before
   returning any result: the app froze solid, with no progress and no way out.

   Now the index is built in chunks that yield to the event loop, it reports
   progress, it can be cancelled (a new search or a new document), and it is
   kept between searches. */
let pageTexts = null;        // per-page plain text, cached per document
let indexing = null;         // in-flight indexing promise
let indexAbort = false;
let findState = { query: '', flat: [], idx: -1 }; // flat = page number per match

function cancelTextIndex() {
  indexAbort = true;
  indexing = null;
  pageTexts = null;
  setSearchProgress(0);
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

async function ensurePageTexts() {
  if (pageTexts) return pageTexts;
  if (indexing) return indexing;
  if (!pdfDoc) return null;

  indexAbort = false;
  const doc = pdfDoc;
  const total = doc.numPages;
  indexing = (async () => {
    const texts = new Array(total);
    for (let n = 1; n <= total; n++) {
      if (indexAbort || doc !== pdfDoc) return null;
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      texts[n - 1] = tc.items.map((i) => i.str).join(' ');
      // Release the page's parsed data — holding 7 000 of them is hundreds of
      // MB. A page that is currently ON SCREEN is exempt: cleanup() drops the
      // operator list the in-flight render is reading from.
      if (!mounted.has(n - 1)) page.cleanup();
      // Yield every few pages so the UI keeps painting and stays interactive.
      if (n % 25 === 0) {
        setSearchProgress(n / total);
        await nextFrame();
      }
    }
    setSearchProgress(1);
    pageTexts = texts;
    indexing = null;
    return texts;
  })();
  return indexing;
}

function countIn(text, q) {
  let n = 0, i = 0;
  const t = text.toLowerCase(), k = q.toLowerCase();
  while ((i = t.indexOf(k, i)) >= 0) { n++; i += k.length; }
  return n;
}

/** Run a (case-insensitive) search over the whole PDF; returns total matches.
 *  Indexing happens off the UI thread's critical path (see ensurePageTexts). */
export async function pdfSearch(query) {
  findState = { query: query || '', flat: [], idx: -1 };
  clearFindHighlights();
  if (!query) { setSearchProgress(0); return 0; }
  const texts = await ensurePageTexts();
  if (!texts || findState.query !== query) return 0; // cancelled or superseded
  for (let p = 0; p < texts.length; p++) {
    const c = countIn(texts[p], query);
    for (let k = 0; k < c; k++) findState.flat.push(p + 1);
  }
  setSearchProgress(0);
  return findState.flat.length;
}

/** Jump to the next/previous match; highlights it in the page's text layer. */
export function pdfFindNext(dir = 1) {
  const f = findState;
  if (!f.flat.length) return { idx: -1, total: 0 };
  f.idx = (f.idx + dir + f.flat.length) % f.flat.length;
  const pageN = f.flat[f.idx];
  goToPage(pageN);
  // Highlight once the page has actually rendered its text layer.
  renderVisible().then(() => setTimeout(() => highlightMatches(pageN, f.query), 120));
  return { idx: f.idx, total: f.flat.length };
}

function clearFindHighlights() {
  if (!container) return;
  // Unwrap: flatten any text-layer span that holds match marks back to plain text.
  container.querySelectorAll('.pdf-textlayer span').forEach((s) => {
    if (s.querySelector('.pdf-find')) s.textContent = s.textContent;
  });
}

// Highlight ONLY the matched substring(s) inside each text span — not the whole
// line/sentence the span contains. The match is wrapped in an inline
// <span class="pdf-find"> that flows within the (scaleX-transformed) parent, so
// the highlight covers exactly the searched word.
function highlightMatches(pageN, query) {
  clearFindHighlights();
  const wrap = mounted.get(pageN - 1);
  if (!wrap || !query) return;
  const k = query.toLowerCase();
  let first = null;
  wrap.querySelectorAll('.pdf-textlayer span').forEach((s) => {
    const txt = s.textContent;
    const low = txt.toLowerCase();
    let i = low.indexOf(k);
    if (i < 0) return;
    const frag = document.createDocumentFragment();
    let pos = 0;
    while (i >= 0) {
      if (i > pos) frag.appendChild(document.createTextNode(txt.slice(pos, i)));
      const mark = document.createElement('span');
      mark.className = 'pdf-find';
      mark.textContent = txt.slice(i, i + k.length);
      frag.appendChild(mark);
      if (!first) first = mark;
      pos = i + k.length;
      i = low.indexOf(k, pos);
    }
    if (pos < txt.length) frag.appendChild(document.createTextNode(txt.slice(pos)));
    s.textContent = '';
    s.appendChild(frag);
  });
  if (first) {
    first.classList.add('pdf-find-current');
    first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

/* ---------- circular magnifier loupe (double-click or magnifier tool) ----------
   RESOLUTION CONTRACT — this is why the loupe is not pixelated.

   The loupe used to sample the page's on-screen canvas and scale it up by
   LZOOM. That canvas is rasterized for the CURRENT zoom, so magnifying it 3×
   is a 3× upscale of a finished bitmap: blurry at best, blocky at worst. No
   amount of `imageSmoothingQuality` fixes missing pixels.

   The loupe now asks PDF.js to rasterize the region under the cursor AT THE
   MAGNIFIED RESOLUTION — scale × LZOOM × device density — so what it shows was
   never a small image. Text is as sharp as if the page were really at 300%.

   The cost is bounded by only rendering a TILE a little larger than the loupe
   and reusing it until the cursor leaves it, and by never having more than one
   render in flight. Moving the loupe inside a tile is a plain drawImage. */
let loupe = null, loupeCtx = null;
const LSIZE = 200, LZOOM = 3;
const TILE_PAD = 1.6;      // tile side, in loupe diameters
let tile = null;           // { page, scale, left, top, w, h, canvas } in CSS px
let tileBusy = false;      // one PDF.js render at a time
let tileWanted = null;     // last request while a render was in flight

function openLoupe() {
  if (loupe) return;
  const dens = dpr() * LZOOM;
  loupe = document.createElement('canvas');
  loupe.width = Math.round(LSIZE * dens);
  loupe.height = Math.round(LSIZE * dens);
  loupe.style.width = LSIZE + 'px';
  loupe.style.height = LSIZE + 'px';
  loupe.className = 'pdf-loupe';
  document.body.appendChild(loupe);
  loupeCtx = loupe.getContext('2d', { alpha: false });
}
function closeLoupe() {
  if (loupe) loupe.remove();
  loupe = null; loupeCtx = null; tile = null; tileWanted = null;
}

/** Rasterize a region of `pageN` (page-local CSS px) at the loupe's resolution. */
async function renderTile(pageN, left, top, side) {
  if (!pdfDoc) return;
  tileBusy = true;
  try {
    const page = await pdfDoc.getPage(pageN);
    const s = getScale();
    const dens = dpr() * LZOOM;
    const vp = page.getViewport({ scale: s * dens });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(side * dens);
    canvas.height = Math.round(side * dens);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Shift the page so the requested region lands at the canvas origin.
    await page.render({
      canvasContext: ctx,
      viewport: vp,
      transform: [1, 0, 0, 1, -left * dens, -top * dens],
    }).promise;
    tile = { page: pageN, scale: s, left, top, w: side, h: side, canvas, dens };
  } catch (_) {
    // A cancelled or failed render just leaves the previous tile in place.
  } finally {
    tileBusy = false;
    const next = tileWanted;
    tileWanted = null;
    if (next && loupe) renderTile(next.pageN, next.left, next.top, next.side).then(paintLoupe);
  }
}

/** Draw the current tile into the loupe, centred on the cursor position. */
let loupeAt = null; // { pageN, x, y } page-local CSS px
function paintLoupe() {
  if (!loupe || !loupeAt) return;
  const B = loupe.width;
  loupeCtx.save();
  loupeCtx.beginPath();
  loupeCtx.arc(B / 2, B / 2, B / 2 - 2, 0, Math.PI * 2);
  loupeCtx.clip();
  loupeCtx.fillStyle = '#fff';
  loupeCtx.fillRect(0, 0, B, B);
  const t = tile;
  if (t && t.page === loupeAt.pageN && t.scale === getScale()) {
    // 1 CSS px of page → `dens` px of tile → the same in the loupe backing,
    // so the tile is drawn 1:1 and nothing is resampled.
    const sx = (loupeAt.x - t.left) * t.dens - B / 2;
    const sy = (loupeAt.y - t.top) * t.dens - B / 2;
    loupeCtx.drawImage(t.canvas, sx, sy, B, B, 0, 0, B, B);
  }
  loupeCtx.restore();
}

function drawLoupe(e) {
  if (!loupe) return;
  loupe.style.left = e.clientX - LSIZE / 2 + 'px';
  loupe.style.top = e.clientY - LSIZE / 2 + 'px';
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const pageEl = el && el.closest ? el.closest('.pdf-page') : null;
  if (!pageEl) {
    loupeAt = null;
    loupeCtx.fillStyle = '#fff';
    loupeCtx.fillRect(0, 0, loupe.width, loupe.height);
    return;
  }
  const r = pageEl.getBoundingClientRect();
  const pageN = parseInt(pageEl.dataset.page, 10);
  loupeAt = { pageN, x: e.clientX - r.left, y: e.clientY - r.top };

  // Does the cursor still sit comfortably inside the cached tile?
  const need = LSIZE / LZOOM;           // page CSS px the loupe shows
  const side = need * TILE_PAD;
  const t = tile;
  const inside = t && t.page === pageN && t.scale === getScale()
    && loupeAt.x - need / 2 >= t.left && loupeAt.x + need / 2 <= t.left + t.w
    && loupeAt.y - need / 2 >= t.top && loupeAt.y + need / 2 <= t.top + t.h;
  if (!inside) {
    const req = {
      pageN,
      left: Math.max(0, loupeAt.x - side / 2),
      top: Math.max(0, loupeAt.y - side / 2),
      side,
    };
    if (tileBusy) tileWanted = req;
    else renderTile(req.pageN, req.left, req.top, req.side).then(paintLoupe);
  }
  paintLoupe();
}
