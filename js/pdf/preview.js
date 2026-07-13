// PDF preview (PDF.js) with VIRTUALIZED rendering: page placeholders are laid
// out at the right size up-front, but only the pages near the viewport are
// rasterized. Zoom just resizes the placeholders (instant) and re-renders the
// few visible pages — so compile-and-view and zoom stay fast even on big A3
// reports. Includes cursor-anchored Ctrl/right-wheel zoom, a circular loupe,
// select/pan tools and a selectable text layer.

import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { readBinaryFile, openExternal, synctexEdit, pathExists, emitToWindow } from '../core/platform.js';
import { baseName } from '../core/paths.js';
import { setAnnotDoc, buildAnnotLayer } from './annotate.js';
import { general } from '../solid/stores/settingsStore.js';
import {
  getScale, setScale, getFitMode, setFitMode,
  setNumPages, setCurrentPage, setPreviewFile, setHasPdf, tool, setLastArea,
  setLoadError,
} from '../solid/stores/previewStore.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

let container = null;
let pdfDoc = null;
let currentBytes = null;
let currentPath = null;
let pageEls = [];          // wrap divs; index 0 = page 1
let baseW = 0, baseH = 0;  // page-1 size at scale 1 (used to size placeholders)
let renderSeq = 0;         // bumped to cancel in-flight page renders
let scrollRaf = 0;
let resizeObs = null;
let lastWidth = 0;
let resizeTimer = null;

const BUFFER = 1.2;        // how many viewport-heights to render beyond the view
const KEEP = 6;            // keep this many pages each side rendered (memory cap)

function dpr() { return Math.max(1, window.devicePixelRatio || 1); }
// Pages always re-rasterize at the EXACT current scale × density, so the page is
// effectively vector-sharp at every zoom. Manual zoom is capped at 400%.
function clampScale(s) { return Math.max(0.1, Math.min(4, +s.toFixed(3))); }

export function setPreviewContainer(el) {
  // The preview pane unmounts/remounts (maximize viewer, hide/show preview,
  // closing the detached window). pageEls reference the PREVIOUS container's
  // DOM, so on a NEW element they must be dropped — otherwise openDoc's
  // "reuse pages" path renders into the old (detached) nodes and the new pane
  // stays blank.
  if (container !== el) pageEls = [];
  container = el;
  // Events must attach to EVERY new container element, not once per module.
  attachEvents(el);
  if (resizeObs) resizeObs.disconnect();
  lastWidth = el.clientWidth;
  resizeObs = new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - lastWidth) < 2) return;
    lastWidth = container.clientWidth;
    if (getFitMode() === 'none') { scheduleVisible(); return; }
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
  // Live recompiles must not jump the view: keep the reading position.
  const keepTop = container.scrollTop, keepLeft = container.scrollLeft;
  const bytes = currentBytes.slice();
  const prev = pdfDoc;
  pageTexts = null; // new document → invalidate the search text cache
  pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  if (prev) { try { await prev.destroy(); } catch (_) {} }
  setNumPages(pdfDoc.numPages);
  setHasPdf(true);
  const p1 = await pdfDoc.getPage(1);
  const vp = p1.getViewport({ scale: 1 });
  baseW = vp.width; baseH = vp.height;
  setAnnotDoc(currentPath, baseW, baseH); // load this PDF's saved annotations
  applyFit();
  // NO blank flash on recompiles: when the page count is unchanged, KEEP the
  // old rasters on screen and let each page swap to its new image the moment
  // it finishes rendering (renderPage replaces a page's content atomically).
  if (pageEls.length === pdfDoc.numPages && pageEls.length) {
    renderSeq++;
    const s = getScale();
    for (const wrap of pageEls) {
      wrap.style.width = Math.floor(baseW * s) + 'px';
      wrap.style.height = Math.floor(baseH * s) + 'px';
      wrap.dataset.rscale = ''; // stale: force re-render with the NEW content
    }
  } else {
    buildPlaceholders();
    container.scrollTop = keepTop;
    container.scrollLeft = keepLeft;
  }
  // Second fit pass: laying the pages out may have shown a scrollbar, which
  // changes the available size — re-fit so the page lands exactly.
  if (getFitMode() !== 'none') { applyFit(); relayout(); }
  renderVisible();
}

function applyFit() {
  const mode = getFitMode();
  if (mode === 'none' || !baseW || !container) return;
  // Measure the REAL available area: client size minus the actual padding
  // (clientWidth already excludes the scrollbar).
  const cs = getComputedStyle(container);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const availW = Math.max(100, container.clientWidth - padX - 2);
  const availH = Math.max(100, container.clientHeight - padY - 2);
  let s = getScale();
  if (mode === 'width') s = availW / baseW;
  else if (mode === 'height') s = availH / baseH;
  else if (mode === 'page') s = Math.min(availW / baseW, availH / baseH);
  else if (mode === 'text') s = availW / (baseW * 0.74);
  setScale(clampScale(s));
}

// Robust fit: TWO passes. The first fit may add or remove a scrollbar, which
// changes the available width/height; the second reads the corrected client
// size, so the page lands EXACTLY in the fit axis with no leftover scrollbar —
// the precise "fit to width/height" a real PDF viewer gives.
function fitToView() {
  if (getFitMode() === 'none') return;
  applyFit(); relayout();
  applyFit(); relayout();
}

function buildPlaceholders() {
  renderSeq++; // abandon any in-flight render
  pageEls = [];
  const s = getScale();
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page';
    wrap.dataset.page = String(n);
    wrap.style.width = Math.floor(baseW * s) + 'px';
    wrap.style.height = Math.floor(baseH * s) + 'px';
    pageEls.push(wrap);
    frag.appendChild(wrap);
  }
  container.replaceChildren(frag);
}

// Resize every placeholder to the current scale, GPU-stretching the already
// rendered raster to the new size (instant, never blank). The stretched raster
// is temporarily soft; renderVisible() then re-rasterizes the visible pages at
// the exact new scale, restoring full sharpness.
function relayout() {
  renderSeq++;
  const s = getScale();
  for (const wrap of pageEls) {
    wrap.style.width = Math.floor(baseW * s) + 'px';
    wrap.style.height = Math.floor(baseH * s) + 'px';
    const content = wrap.firstChild;
    const rs = parseFloat(wrap.dataset.rscale || '0');
    if (content && rs) {
      content.style.transformOrigin = '0 0';
      content.style.transform = rs === s ? '' : `scale(${s / rs})`;
    }
  }
}

function visibleIndices() {
  const top = container.scrollTop - container.clientHeight * BUFFER;
  const bottom = container.scrollTop + container.clientHeight * (1 + BUFFER);
  const out = [];
  for (let i = 0; i < pageEls.length; i++) {
    const w = pageEls[i];
    const t = w.offsetTop, b = t + w.offsetHeight;
    if (b >= top && t <= bottom) out.push(i);
  }
  return out;
}

async function renderVisible() {
  if (!pdfDoc || !pageEls.length) return;
  const seq = renderSeq;
  const s = getScale();
  const vis = visibleIndices();
  if (!vis.length) return;

  // Free far-away pages to cap memory.
  const lo = vis[0] - KEEP, hi = vis[vis.length - 1] + KEEP;
  for (let i = 0; i < pageEls.length; i++) {
    if ((i < lo || i > hi) && pageEls[i].dataset.rscale) {
      pageEls[i].replaceChildren();
      pageEls[i].dataset.rscale = '';
    }
  }

  for (const i of vis) {
    if (seq !== renderSeq) return;
    const wrap = pageEls[i];
    if (wrap.dataset.rscale === String(s)) continue;
    await renderPage(i + 1, wrap, s, seq);
  }
  setCurrentPage(currentVisiblePage());
}

async function renderPage(n, wrap, s, seq) {
  const page = await pdfDoc.getPage(n);
  if (seq !== renderSeq) return;
  const vp = page.getViewport({ scale: s });
  wrap.style.width = Math.floor(vp.width) + 'px';
  wrap.style.height = Math.floor(vp.height) + 'px';

  // Rasterize at EXACTLY the device resolution (1 canvas pixel = 1 screen
  // pixel). The old dpr×quality supersampling forced the browser to MINIFY the
  // canvas, and bilinear minification skips texels — hairlines (the 0.4–0.5pt
  // header/footer rules) landed between samples and faded to near-transparent
  // depending on their vertical position. Device-exact rendering keeps every
  // rule crisp (TeXstudio behaviour); zoom sharpness is unaffected because
  // pages re-rasterize at the exact scale after every zoom.
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
  if (seq !== renderSeq) return;

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
    const wrap = pageEls[idx];
    if (!wrap) return;
    let top = wrap.offsetTop;
    const kind = d[1] && d[1].name;
    // y is in PDF units measured from the BOTTOM of the page.
    const yPdf = kind === 'XYZ' ? d[3] : (kind === 'FitH' || kind === 'FitBH') ? d[2] : null;
    if (yPdf != null) {
      // Use the DESTINATION page's own height (documents can mix A4/A3,
      // portrait/landscape) — baseH is page 1's and lands wrong on others.
      let pageH = baseH;
      try {
        const pg = await pdfDoc.getPage(idx + 1);
        pageH = pg.view[3] - pg.view[1] || baseH;
      } catch (_) { /* keep page-1 height */ }
      if (pageH) top += Math.max(0, (1 - yPdf / pageH)) * wrap.offsetHeight - 8;
    }
    container.scrollTop = Math.max(0, top);
    setCurrentPage(idx + 1);
    scheduleVisible();
  } catch (_) { /* malformed destination */ }
}

/* ---------- SyncTeX forward search: scroll to a source line's PDF spot ------ */
// `page` is 1-based; x/y are PDF points from the page's TOP-LEFT corner (the
// synctex CLI convention). Scrolls there and flashes a TeXstudio-style marker.
export async function showPdfLocation(page, x, y) {
  if (!pdfDoc) return;
  const wrap = pageEls[page - 1];
  if (!wrap) return;
  let frac = 0;
  try {
    const pg = await pdfDoc.getPage(page);
    const pageH = pg.view[3] - pg.view[1];
    if (pageH) frac = Math.max(0, Math.min(1, y / pageH));
  } catch (_) { /* page top */ }
  const yPx = frac * wrap.offsetHeight;
  container.scrollTop = Math.max(0, wrap.offsetTop + yPx - container.clientHeight * 0.4);
  setCurrentPage(page);
  scheduleVisible();
  // flash marker at the target position
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
    let p = String(hit.input || '').replace(/\//g, '\\');
    // The engine compiles <stem>.build.tex — map back to the real source file.
    if (/\.build\.tex$/i.test(p)) {
      const stem = p.replace(/\.build\.tex$/i, '');
      for (const cand of [stem + '.pltx', stem + '.tex']) {
        if (await pathExists(cand)) { p = cand; break; }
      }
    }
    const line = hit.line || 1;
    const column = typeof hit.column === 'number' ? hit.column : -1;
    // The detached viewer window has no editor: ask the MAIN window to open
    // the source file at this exact spot (and focus itself).
    if (typeof window !== 'undefined' && window.__PYX_VIEWER__) {
      emitToWindow('main', 'synctex:open', { path: p, line, column, word });
      return;
    }
    const docStore = await import('../solid/stores/docStore.js');
    await docStore.openPath(p);
    const cmds = await import('../editor/commands.js');
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
    for (const span of layer.children) {
      const w = parseFloat(span.dataset.w || '0');
      if (w && span.offsetWidth) {
        span.style.transform = `scaleX(${w / span.offsetWidth})`;
        span.style.transformOrigin = 'left top';
      }
    }
  });
}

/* ---------- controls ---------- */
export function setZoom(s) {
  setFitMode('none');
  setScale(clampScale(s));
  relayout();
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
  // Re-center horizontally and keep the current page at the top of the view.
  container.scrollLeft = Math.max(0, (container.scrollWidth - container.clientWidth) / 2);
  const w = pageEls[page - 1];
  if (w && mode === 'height') container.scrollTop = Math.max(0, w.offsetTop - 8);
  renderVisible();
}
export function rerender() { relayout(); renderVisible(); }
export function hasPdf() { return !!pdfDoc; }

// Anchor = which page is under the cursor + the fractional position inside it.
// Scale-independent, so zoom lands exactly under the mouse.
function buildAnchor(clientX, clientY) {
  if (!container || !pageEls.length) return null;
  const rect = container.getBoundingClientRect();
  const offX = clientX - rect.left, offY = clientY - rect.top;
  const contentX = container.scrollLeft + offX;
  const contentY = container.scrollTop + offY;
  let idx = -1;
  for (let i = 0; i < pageEls.length; i++) {
    const w = pageEls[i];
    if (contentY >= w.offsetTop && contentY <= w.offsetTop + w.offsetHeight) { idx = i; break; }
  }
  if (idx < 0) {
    let bestD = Infinity;
    for (let i = 0; i < pageEls.length; i++) {
      const w = pageEls[i];
      const d = Math.abs(w.offsetTop + w.offsetHeight / 2 - contentY);
      if (d < bestD) { bestD = d; idx = i; }
    }
  }
  if (idx < 0) return null;
  const w = pageEls[idx];
  return { idx, fx: (contentX - w.offsetLeft) / w.offsetWidth, fy: (contentY - w.offsetTop) / w.offsetHeight, offX, offY };
}
function applyAnchor(a) {
  const w = pageEls[a.idx];
  if (!w) return;
  container.scrollLeft = w.offsetLeft + a.fx * w.offsetWidth - a.offX;
  container.scrollTop = w.offsetTop + a.fy * w.offsetHeight - a.offY;
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
  relayout();
  if (anchor) applyAnchor(anchor);
  clearTimeout(settleTimer);
  // Re-rasterize quickly so the brief GPU-stretched (soft) frame is barely seen
  // and the page is sharp again almost immediately.
  settleTimer = setTimeout(() => renderVisible(), 70);
}

export function goToPage(n) {
  const w = pageEls[n - 1];
  if (w) { w.scrollIntoView({ behavior: 'smooth', block: 'start' }); setCurrentPage(n); scheduleVisible(); }
}
export function goFirst() { goToPage(1); }
export function goLast() { if (pdfDoc) goToPage(pdfDoc.numPages); }
export function goPrev() { goToPage(Math.max(1, currentVisiblePage() - 1)); }
export function goNext() { goToPage(Math.min(pdfDoc?.numPages || 1, currentVisiblePage() + 1)); }

function currentVisiblePage() {
  if (!container || !pageEls.length) return 1;
  const mid = container.scrollTop + container.clientHeight / 2;
  let best = 1, bestD = Infinity;
  for (let i = 0; i < pageEls.length; i++) {
    const w = pageEls[i];
    const c = w.offsetTop + w.offsetHeight / 2;
    const d = Math.abs(c - mid);
    if (d < bestD) { bestD = d; best = i + 1; }
  }
  return best;
}

function scheduleVisible() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; renderVisible(); setCurrentPage(currentVisiblePage()); });
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
        // baseW/baseH are the page size at scale 1 = PDF points (synctex units,
        // origin at the TOP-left like its output).
        synctexJump(
          parseInt(pageEl.dataset.page, 10),
          ((e.clientX - r.left) / r.width) * baseW,
          ((e.clientY - r.top) / r.height) * baseH,
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
  synctexJump(
    parseInt(pageEl.dataset.page, 10),
    ((rect.left - r.left) / r.width) * baseW,
    ((rect.top - r.top) / r.height) * baseH,
    text
  );
}

/* ---------- PDF text search (focus-aware Ctrl+F target) ---------- */
let pageTexts = null; // per-page plain text, cached per document
let findState = { query: '', flat: [], idx: -1 }; // flat = page number per match

async function ensurePageTexts() {
  if (pageTexts || !pdfDoc) return;
  const texts = [];
  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    const tc = await page.getTextContent();
    texts.push(tc.items.map((i) => i.str).join(' '));
  }
  pageTexts = texts;
}

function countIn(text, q) {
  let n = 0, i = 0;
  const t = text.toLowerCase(), k = q.toLowerCase();
  while ((i = t.indexOf(k, i)) >= 0) { n++; i += k.length; }
  return n;
}

/** Run a (case-insensitive) search over the whole PDF; returns total matches. */
export async function pdfSearch(query) {
  await ensurePageTexts();
  findState = { query: query || '', flat: [], idx: -1 };
  clearFindHighlights();
  if (!query || !pageTexts) return 0;
  for (let p = 0; p < pageTexts.length; p++) {
    const c = countIn(pageTexts[p], query);
    for (let k = 0; k < c; k++) findState.flat.push(p + 1);
  }
  return findState.flat.length;
}

/** Jump to the next/previous match; highlights it in the page's text layer. */
export function pdfFindNext(dir = 1) {
  const f = findState;
  if (!f.flat.length) return { idx: -1, total: 0 };
  f.idx = (f.idx + dir + f.flat.length) % f.flat.length;
  const pageN = f.flat[f.idx];
  goToPage(pageN);
  // Highlight after the page has had a chance to render its text layer.
  setTimeout(() => highlightMatches(pageN, f.query), 380);
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
  const wrap = pageEls[pageN - 1];
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
   The loupe samples the page's HIGH-DENSITY backing canvas (os× the display
   resolution) and its own backing is LDENS× too, so the magnified text stays
   crisp ("vectorial"), not a blown-up blurry raster. */
let loupe = null, loupeCtx = null;
const LSIZE = 200, LZOOM = 3, LDENS = 2;
function openLoupe() {
  if (loupe) return;
  loupe = document.createElement('canvas');
  loupe.width = LSIZE * LDENS; loupe.height = LSIZE * LDENS;
  loupe.style.width = LSIZE + 'px'; loupe.style.height = LSIZE + 'px';
  loupe.className = 'pdf-loupe';
  document.body.appendChild(loupe);
  loupeCtx = loupe.getContext('2d');
}
function closeLoupe() {
  if (loupe) loupe.remove();
  loupe = null; loupeCtx = null;
}
function drawLoupe(e) {
  if (!loupe) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const page = el && el.closest ? el.closest('.pdf-page') : null;
  const canvas = page ? page.querySelector('canvas') : null;
  loupe.style.left = e.clientX - LSIZE / 2 + 'px';
  loupe.style.top = e.clientY - LSIZE / 2 + 'px';
  const B = LSIZE * LDENS;
  if (!canvas) { loupeCtx.clearRect(0, 0, B, B); return; }
  const rect = canvas.getBoundingClientRect();
  const fx = (e.clientX - rect.left) / rect.width;
  const fy = (e.clientY - rect.top) / rect.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
  // os = backing pixels per displayed pixel; sample a region that magnifies the
  // DISPLAYED page by exactly LZOOM, taken from the dense backing → sharp.
  const os = canvas.width / (parseFloat(canvas.style.width) || rect.width);
  const cx = fx * canvas.width, cy = fy * canvas.height;
  const sw = (LSIZE / LZOOM) * os, sh = (LSIZE / LZOOM) * os;
  loupeCtx.save();
  loupeCtx.clearRect(0, 0, B, B);
  loupeCtx.beginPath();
  loupeCtx.arc(B / 2, B / 2, B / 2 - LDENS, 0, Math.PI * 2);
  loupeCtx.clip();
  loupeCtx.fillStyle = '#fff';
  loupeCtx.fillRect(0, 0, B, B);
  loupeCtx.imageSmoothingEnabled = true;
  loupeCtx.imageSmoothingQuality = 'high';
  loupeCtx.drawImage(canvas, cx - sw / 2, cy - sh / 2, sw, sh, 0, 0, B, B);
  loupeCtx.restore();
}
