import { onMount, onCleanup, createSignal, createEffect, Show, For } from 'solid-js';
import { state } from '../../core/state.js';
import {
  setPreviewContainer, rerender, zoomBy, setZoom, setFit,
  goFirst, goPrev, goNext, goLast, goToPage, getPdfPath, pdfSearch, pdfFindNext,
} from '../../pdf/preview.js';
import {
  scale, numPages, currentPage, fitMode, tool, setTool, invert, setInvert, previewFile, hasPdf,
  pdfSearchOpen, setPdfSearchOpen, loadError, setAuxOpen, searchProgress,
  annotBarOpen, setAnnotBarOpen, annotTool, setAnnotTool, annotColor, setAnnotColor,
  annotWidth, setAnnotWidth,
} from '../stores/previewStore.js';
import { undo, redo, clearPage, correctionsText, TEXT_TOOLS } from '../../pdf/annotate.js';
import {
  openExternal, openPdfExternal, openViewerWindow, messageDialog, savePdfDialog, copyFile,
} from '../../core/platform.js';
import { icons as ICO } from './ribbon/icons.js';
import PdfOutline from './PdfOutline.jsx';
import { createAnchoredPopup } from './createAnchoredPopup.js';

// Viewer toolbar icons — same hand as the ribbon and the notebook cells:
// a 16x16 box, 1.2px strokes, no fills unless the shape IS a solid. The
// comment on each line names the codicon it is modelled on.
const S = 'viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"';
const ic = {
  first: `<svg ${S}><path d="M4 3.2v9.6M12 3.6 7.6 8l4.4 4.4"/></svg>`,                 // codicon: chevron-left + bar
  prev: `<svg ${S}><path d="m10.2 3.6-4.4 4.4 4.4 4.4"/></svg>`,                          // codicon: chevron-left
  next: `<svg ${S}><path d="m5.8 3.6 4.4 4.4-4.4 4.4"/></svg>`,                           // codicon: chevron-right
  last: `<svg ${S}><path d="M12 3.2v9.6M4 3.6 8.4 8 4 12.4"/></svg>`,                     // codicon: chevron-right + bar
  zin: `<svg ${S}><circle cx="6.8" cy="6.8" r="4.4"/><path d="m10.1 10.1 4.4 4.4M6.8 4.7v4.2M4.7 6.8h4.2"/></svg>`,  // codicon: zoom-in
  zout: `<svg ${S}><circle cx="6.8" cy="6.8" r="4.4"/><path d="m10.1 10.1 4.4 4.4M4.7 6.8h4.2"/></svg>`,             // codicon: zoom-out
  fitW: `<svg ${S}><path d="M2 8h12M5 5 2 8l3 3M11 5l3 3-3 3"/></svg>`,                   // codicon: arrow-both
  fitH: `<svg ${S}><path d="M8 2v12M5 5l3-3 3 3M5 11l3 3 3-3"/></svg>`,                   // codicon: arrow-both (rotated)
  sel: `<svg ${S}><path d="M3.6 2.4 12.8 6.6 8.7 8 7.3 12.1z"/></svg>`,                   // codicon: inspect
  pan: `<svg ${S}><path d="M6.6 7.2V3.8a1.1 1.1 0 0 1 2.2 0v3.2m0-1.1a1.1 1.1 0 0 1 2.2 0v2.4m0-1.6a1.1 1.1 0 0 1 2.2 0v3.8a3.4 3.4 0 0 1-3.4 3.4H7.7l-2.5-2.5-2-2.4a1.2 1.2 0 0 1 1.8-1.5l1.6 1.7"/></svg>`,
  mag: `<svg ${S}><circle cx="7" cy="7" r="4.5"/><path d="m10.3 10.3 4.2 4.2"/></svg>`,    // codicon: search
  contrast: `<svg ${S}><circle cx="8" cy="8" r="5.6"/><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor" stroke="none"/></svg>`, // codicon: color-mode
  max: `<svg ${S}><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>`, // codicon: screen-full
  float: `<svg ${S}><path d="M7.4 2.5H2.5v11h11V8.6M10 2.5h3.5V6M13.5 2.5 7.8 8.2"/></svg>`, // codicon: link-external
  save: `<svg ${S}><path d="M8 2.4v7.4M5 6.8 8 9.8l3-3M2.8 12v1.6h10.4V12"/></svg>`,      // codicon: desktop-download
  detach: `<svg ${S}><rect x="1.5" y="5.5" width="8.6" height="8.6" rx="1"/><path d="M5.8 5.5V2.4a.9.9 0 0 1 .9-.9h7.9v8.6a.9.9 0 0 1-.9.9h-3.6"/></svg>`, // codicon: multiple-windows
  close: `<svg ${S}><path d="m3.6 3.6 8.8 8.8M12.4 3.6l-8.8 8.8"/></svg>`,                // codicon: close
  find: `<svg ${S}><circle cx="7" cy="7" r="4.5"/><path d="m10.3 10.3 4.2 4.2"/></svg>`,  // codicon: search
  draw: `<svg ${S}><path d="m2.5 13.5.9-3 7.3-7.3 2.1 2.1-7.3 7.3z"/><path d="m9.4 4.6 2.1 2.1"/></svg>`, // codicon: edit
  pen: `<svg ${S}><path d="m2.5 13.5.9-3 7.3-7.3 2.1 2.1-7.3 7.3z"/><path d="m9.4 4.6 2.1 2.1"/></svg>`,  // codicon: edit
  marker: `<svg ${S}><path d="M4.2 12.3 3.4 14h3.4l-.8-1.7"/><path d="m5 11.4 4.6-7.2 2.6 1.7-4.6 7.2z"/></svg>`,
  rect: `<svg ${S}><rect x="2.5" y="3.5" width="11" height="9" rx="1"/></svg>`,           // codicon: primitive-square
  arrow: `<svg ${S}><path d="M3 13 12.6 3.4M12.6 3.4H8.3M12.6 3.4v4.3"/></svg>`,          // codicon: arrow-up-right
  line: `<svg ${S}><path d="M3 13 13 3"/></svg>`,
  noteText: `<svg ${S}><path d="M4 3h8M8 3v10"/></svg>`,                                  // codicon: symbol-text
  eraser: `<svg ${S}><path d="m5.6 13.2-2.8-2.8 6-6 2.8 2.8-6 6zM7.8 13.2h5.6"/></svg>`,
  select: `<svg ${S}><path d="M3.6 2.4 12.8 6.6 8.7 8 7.3 12.1z"/></svg>`,                // codicon: inspect
  texthl: `<svg ${S}><rect x="2" y="8.6" width="12" height="4.6" rx="0.8" fill="currentColor" fill-opacity="0.35" stroke="none"/><path d="M4.6 12.2 8 3.2l3.4 9M5.8 9.2h4.4"/></svg>`,
  underline: `<svg ${S}><path d="M4.8 2.8v4.4a3.2 3.2 0 0 0 6.4 0V2.8M3.6 13.4h8.8"/></svg>`,
  strike: `<svg ${S}><path d="M11 4.4C10.4 3.3 9.3 2.8 8 2.8c-1.8 0-3 .9-3 2.2 0 .7.3 1.2.9 1.6M5 11c.5 1.4 1.7 2.2 3.2 2.2 1.9 0 3.1-1 3.1-2.4 0-.5-.1-.9-.4-1.2M2.4 8h11.2"/></svg>`,
  ellipse: `<svg ${S}><ellipse cx="8" cy="8" rx="5.8" ry="4.4"/></svg>`,                    // codicon: circle-large
  note: `<svg ${S}><path d="M3 3h10a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H8.2L5 13.6v-2.4H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/></svg>`, // codicon: comment
  redo: `<svg ${S}><path d="M13.5 6.4h-7a3.8 3.8 0 0 0 0 7.6H10"/><path d="m10.4 3.3 3.1 3.1-3.1 3.1"/></svg>`,
  copyList: `<svg ${S}><rect x="5" y="4.5" width="8.5" height="9.5" rx="1"/><path d="M3 11.5V3a1 1 0 0 1 1-1h7M7 8h4.5M7 10.5h4.5"/></svg>`, // codicon: copy
  undo: `<svg ${S}><path d="M2.5 6.4h7a3.8 3.8 0 0 1 0 7.6H6"/><path d="M5.6 3.3 2.5 6.4l3.1 3.1"/></svg>`, // codicon: discard
  trashAll: `<svg ${S}><path d="M3 4h10M6 4V2.7h4V4M5 4l.7 9h4.6L11 4z"/></svg>`,         // codicon: trash
  outline: `<svg ${S}><path d="M4.5 2.5h7v11l-3.5-2.6-3.5 2.6z"/></svg>`,                // codicon: bookmark
};
const [outlineOpen, setOutlineOpen] = createSignal(false);

// Review tools, in the order a corrector reaches for them: pick/move, the
// three that act on SELECTED TEXT, free drawing, shapes, comments, eraser.
const ANNOT_TOOLS = [
  { id: 'select', icon: 'select', title: 'Seleccionar: mueve una marca arrastrándola; Supr la borra; doble clic edita un comentario' },
  { id: 'texthl', icon: 'texthl', title: 'Resaltar texto (selecciónalo)' },
  { id: 'underline', icon: 'underline', title: 'Subrayar texto (selecciónalo)' },
  { id: 'strike', icon: 'strike', title: 'Tachar texto (selecciónalo)' },
  { id: 'pen', icon: 'pen', title: 'Lápiz (trazo libre suavizado)' },
  { id: 'highlight', icon: 'marker', title: 'Rotulador (resaltado a mano alzada)' },
  { id: 'line', icon: 'line', title: 'Línea (Mayús: 0°/45°/90°)' },
  { id: 'arrow', icon: 'arrow', title: 'Flecha (Mayús: 0°/45°/90°)' },
  { id: 'rect', icon: 'rect', title: 'Recuadro (Mayús: cuadrado)' },
  { id: 'ellipse', icon: 'ellipse', title: 'Elipse (Mayús: círculo)' },
  { id: 'note', icon: 'note', title: 'Comentario: clic donde va; se escribe en la página (Ctrl+Intro termina)' },
  { id: 'eraser', icon: 'eraser', title: 'Borrador (borra las marcas por las que pasa)' },
];
const ANNOT_COLORS = ['#ffd400', '#e23b3b', '#f5a623', '#2ca24c', '#2f7fe0', '#9b51e0', '#1a1a1a'];

/** Copy every mark of the document, page by page, as a list of corrections. */
async function copyCorrections() {
  const text = correctionsText();
  if (!text) { messageDialog('No hay anotaciones en este PDF.'); return; }
  try {
    await navigator.clipboard.writeText(text);
    messageDialog(`Lista de correcciones copiada (${text.split('\n').length} marcas). Pégala en un correo o documento.`);
  } catch (_) {
    messageDialog('No se pudo copiar al portapapeles.');
  }
}

// Annotation toolbar: pick a tool, color and stroke width to mark up the PDF.
// The marks are saved per document and scale with zoom.
function AnnotBar() {
  return (
    <div class="pdf-annotbar">
      <For each={ANNOT_TOOLS}>
        {(t) => (
          <button class={`pv-btn${annotTool() === t.id ? ' active' : ''}`} title={t.title}
            innerHTML={ic[t.icon]}
            onClick={() => setAnnotTool(annotTool() === t.id ? '' : t.id)}></button>
        )}
      </For>
      <div class="pv-sep"></div>
      <For each={ANNOT_COLORS}>
        {(c) => (
          <button class={`annot-swatch${annotColor() === c ? ' active' : ''}`} title={c}
            style={{ background: c }} onClick={() => setAnnotColor(c)}></button>
        )}
      </For>
      <input type="color" class="annot-color" title="Color personalizado"
        value={annotColor()} onInput={(e) => setAnnotColor(e.target.value)} />
      <select class="annot-width" title="Grosor del trazo"
        value={String(annotWidth())} onChange={(e) => setAnnotWidth(+e.target.value)}>
        <option value="1">Fino</option>
        <option value="2">Medio</option>
        <option value="4">Grueso</option>
        <option value="7">Muy grueso</option>
      </select>
      <div class="pv-sep"></div>
      <button class="pv-btn" title="Deshacer (Ctrl+Z)" innerHTML={ic.undo} onClick={undo}></button>
      <button class="pv-btn" title="Rehacer (Ctrl+Y)" innerHTML={ic.redo} onClick={redo}></button>
      <button class="pv-btn" title="Copiar la lista de correcciones (página, tipo y texto de cada marca)" innerHTML={ic.copyList}
        onClick={copyCorrections}></button>
      <button class="pv-btn" title="Borrar las anotaciones de esta página" innerHTML={ic.trashAll}
        onClick={() => clearPage(currentPage())}></button>
      <button class="pv-btn" title="Cerrar la barra de anotación" innerHTML={ic.close}
        onClick={() => { setAnnotTool(''); setAnnotBarOpen(false); }}></button>
    </div>
  );
}

// True when running inside the detached viewer window (native frame has its
// own close button, so the in-toolbar ✕ is hidden there).
const IS_AUX_VIEWER = typeof window !== 'undefined' && !!window.__PYX_VIEWER__;

// Compact search bar for the PDF (the focus-aware Ctrl+F target).
function PdfSearchBar() {
  let inputRef;
  const [total, setTotal] = createSignal(0);
  const [pos, setPos] = createSignal(0);
  let debounce = null;

  const run = (q) => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const n = await pdfSearch(q);
      setTotal(n);
      setPos(0);
      if (n) { const r = pdfFindNext(1); setPos(r.idx + 1); }
    }, 220);
  };
  const step = (dir) => { const r = pdfFindNext(dir); setPos(r.idx + 1); };
  const close = () => { setPdfSearchOpen(false); pdfSearch(''); };

  createEffect(() => { if (pdfSearchOpen() && inputRef) requestAnimationFrame(() => { inputRef.focus(); inputRef.select(); }); });

  return (
    <div class="pdf-search">
      <input
        ref={inputRef}
        type="text"
        placeholder="Buscar en el PDF"
        onInput={(e) => run(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
          else if (e.key === 'Escape') close();
        }}
        spellcheck={false}
      />
      {/* A thousand-page PDF must be parsed page by page before it can be
          searched. Show that progress instead of appearing frozen. */}
      <span class="pdf-search-count">
        {searchProgress() > 0 && searchProgress() < 1
          ? `Indexando… ${Math.round(searchProgress() * 100)}%`
          : total() ? `${pos()} de ${total()}` : 'Sin resultados'}
      </span>
      {/* codicon: arrow-up / arrow-down / close */}
      <button class="pyx-ico" title="Anterior (Shift+Enter)" innerHTML={ICO.arrowUp} onClick={() => step(-1)} />
      <button class="pyx-ico" title="Siguiente (Enter)" innerHTML={ICO.arrowDown} onClick={() => step(1)} />
      <button class="pyx-ico" title="Cerrar (Esc)" innerHTML={ic.close} onClick={close} />
    </div>
  );
}

export default function PreviewPane() {
  let scrollRef;
  onMount(() => setPreviewContainer(scrollRef));
  // No pane, nothing to lay out or paint: a PDF compiled while the viewer is
  // hidden is loaded when it is shown again.
  onCleanup(() => setPreviewContainer(null));

  // A COPY goes to the external application (Rust keeps it up to date after
  // every compile): a reader that locks the file it shows would otherwise
  // keep the engine from ever writing the PDF again.
  const floatWindow = () => {
    const p = getPdfPath();
    if (p) openPdfExternal(p).catch(() => openExternal(p));
  };
  // The compiled PDF lives in the project's working directory, out of sight
  // with the rest of the build. Exporting is how a copy leaves it.
  const exportPdf = async () => {
    const p = getPdfPath();
    if (!p) return;
    const name = (previewFile() || 'documento.pdf').replace(/\.[^.]*$/, '') + '.pdf';
    const dest = await savePdfDialog(name);
    if (!dest) return;
    try {
      await copyFile(p, dest);
    } catch (e) {
      messageDialog(`No se pudo guardar el PDF: ${String((e && e.message) || e)}`,
        { title: 'Exportar PDF', kind: 'error' });
    }
  };
  const detachViewer = () => {
    const p = getPdfPath();
    if (!p) return;
    // The detached window REPLACES the in-app pane: compiles update the
    // auxiliary window, and the pane comes back when that window closes.
    openViewerWindow(p).then(() => {
      setAuxOpen(true);
      state.previewVisible = false;
      state.viewerMaximized = false;
    }).catch((e) =>
      messageDialog(`No se pudo abrir la ventana del visor: ${String((e && e.message) || e)}`));
  };
  const onPageInput = (e) => { const n = parseInt(e.target.value, 10); if (n) goToPage(Math.max(1, Math.min(numPages(), n))); };
  const canPrev = () => hasPdf() && currentPage() > 1;
  const canNext = () => hasPdf() && currentPage() < numPages();

  const Btn = (p) => (
    <button class={`pv-btn${p.active ? ' active' : ''}`} title={p.title} disabled={p.disabled}
      onClick={p.onClick} innerHTML={p.icon}></button>
  );

  /* ---- toolbar overflow: what does not fit goes to the "…" menu ----
     The strip wraps and shows one row (layout.css, .pv-scroll); a control on
     any later row did not fit. The menu is built from those controls
     themselves — name from the tooltip, icon from the button, and a click
     that clicks the real button — so it never has to be kept in step with
     the toolbar above. */
  let stripEl;
  const [overflowed, setOverflowed] = createSignal(0);
  const [moreItems, setMoreItems] = createSignal([]);
  const more = createAnchoredPopup({ align: 'end' });
  const labelOf = (el) => el.getAttribute('data-pyx-tip') || el.getAttribute('title')
    || el.getAttribute('aria-label') || (el.textContent || '').trim();
  const measureStrip = () => {
    if (!stripEl || !stripEl.firstElementChild) return;
    // "On a later row" = starts at least half a row lower than the first
    // control. Not simply "lower": the controls are centred in the row, so a
    // 22px page box sits 1px below a 24px button on the very same row.
    const top = stripEl.firstElementChild.offsetTop;
    const half = stripEl.clientHeight / 2;
    let n = 0;
    for (const el of stripEl.children) {
      const off = el.offsetTop - top >= half;
      if (off) n++;
      if (off !== el.hasAttribute('data-ov')) el.toggleAttribute('data-ov', off);
    }
    setOverflowed(n);
    if (!n) more.close();
  };
  const openMore = () => {
    if (more.open()) { more.close(); return; }
    measureStrip();
    setMoreItems([...stripEl.children].filter((el) => el.hasAttribute('data-ov')).map((el) => (
      el.tagName === 'BUTTON'
        ? {
          el,
          label: labelOf(el),
          // The zoom button is text ("125%"), not an icon.
          icon: el.querySelector('svg') ? el.innerHTML : '',
          disabled: el.disabled,
          active: el.classList.contains('active'),
        }
        : { sep: true }
    // A separator is only worth drawing between two commands.
    )).filter((it, i, all) => !it.sep || (i > 0 && !all[i - 1].sep && i < all.length - 1)));
    more.show();
  };
  onMount(() => {
    if (typeof ResizeObserver !== 'function') return;
    // The strip's width, and the two controls whose own width changes (the
    // page count gains digits, the zoom percentage too).
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; measureStrip(); });
    });
    ro.observe(stripEl);
    for (const el of stripEl.querySelectorAll('.pv-page, .pv-zoom')) ro.observe(el);
    onCleanup(() => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); });
  });

  return (
    <>
      <div class="preview-toolbar">
        {/* The controls are one strip. The whole bar used to be a single flex
            row, so with the side panel open in a 1000px window the last five
            buttons — exportar, ventana auxiliar, abrir fuera, contraste —
            were squeezed past the right edge and simply could not be reached.
            Whatever does not fit in the strip is listed in the "…" menu next
            to it. Only `pv-file` and the close button stay pinned outside:
            a close button that goes into a menu is worse than no menu. */}
        <div class="pv-scroll" ref={stripEl}>
        {/* Greyed out at the ends of the document, like every PDF viewer: the
            four arrows used to look live on page 1 of 1 and simply did nothing
            when clicked. */}
        <Btn icon={ic.first} title="Primera página" disabled={!canPrev()} onClick={goFirst} />
        <Btn icon={ic.prev} title="Página anterior" disabled={!canPrev()} onClick={goPrev} />
        <div class="pv-page">
          <input type="text" value={currentPage()} onChange={onPageInput} disabled={!hasPdf()} />
          <span>/ {numPages() || 0}</span>
        </div>
        <Btn icon={ic.next} title="Página siguiente" disabled={!canNext()} onClick={goNext} />
        <Btn icon={ic.last} title="Última página" disabled={!canNext()} onClick={goLast} />

        <div class="pv-sep"></div>

        <Btn icon={ic.zout} title="Alejar (Ctrl+rueda)" onClick={() => zoomBy(1 / 1.1)} />
        <button class="pv-zoom" title="Restablecer 100%" onClick={() => setZoom(1)}>{Math.round(scale() * 100)}%</button>
        <Btn icon={ic.zin} title="Acercar (Ctrl+rueda)" onClick={() => zoomBy(1.1)} />

        <div class="pv-sep"></div>

        <Btn icon={ic.fitW} title="Ajustar al ancho" active={fitMode() === 'width'} onClick={() => setFit('width')} />
        <Btn icon={ic.fitH} title="Ajustar al alto de la página" active={fitMode() === 'height'} onClick={() => setFit('height')} />

        <div class="pv-sep"></div>

        <Btn icon={ic.sel} title="Seleccionar texto" active={tool() === 'select'} onClick={() => setTool('select')} />
        <Btn icon={ic.pan} title="Mover (mano) — o pulsa la rueda del ratón" active={tool() === 'pan'} onClick={() => setTool('pan')} />
        {/* La lupa ya no es un botón: se activa con doble clic sobre el PDF. */}

        <div class="pv-sep"></div>
        <Btn icon={ic.outline} title="Marcadores: ir a una sección del PDF" active={outlineOpen()}
          disabled={!hasPdf()} onClick={() => setOutlineOpen(!outlineOpen())} />
        <Btn icon={ic.find} title="Buscar en el PDF (Ctrl+F)" active={pdfSearchOpen()}
          disabled={!hasPdf()} onClick={() => setPdfSearchOpen(!pdfSearchOpen())} />
        <Btn icon={ic.draw} title="Anotar / dibujar sobre el PDF" active={annotBarOpen()}
          disabled={!hasPdf()}
          onClick={() => { const o = !annotBarOpen(); setAnnotBarOpen(o); setAnnotTool(o ? 'pen' : ''); }} />
        <Btn icon={ic.contrast} title="Contraste — folio gris (modo noche)" active={invert()} onClick={() => setInvert(!invert())} />
        <Btn icon={ic.max} title="Ampliar visor (ocultar el editor)" active={state.viewerMaximized}
          onClick={() => (state.viewerMaximized = !state.viewerMaximized)} />
        <Btn icon={ic.detach} title="Sacar el visor de Pyx a una ventana auxiliar" disabled={!hasPdf()} onClick={detachViewer} />
        <Btn icon={ic.save} title="Guardar una copia del PDF…" disabled={!hasPdf()} onClick={exportPdf} />
        <Btn icon={ic.float} title="Abrir el PDF en la aplicación externa" disabled={!hasPdf()} onClick={floatWindow} />
        </div>
        <Show when={overflowed() > 0}>
          <button class={`pv-btn pv-more${more.open() ? ' active' : ''}`} ref={more.anchor}
            title="Más herramientas del visor" aria-haspopup="true"
            onClick={openMore} innerHTML={ICO.ellipsis}></button>
        </Show>
        <Show when={more.open()}>
          <div class="ribbon-dd-menu pv-more-menu" ref={more.popup} style={more.style()}>
            <For each={moreItems()}>
              {(it) => (it.sep
                ? <div class="ctx-sep"></div>
                : (
                  <button class={`ribbon-dd-item${it.active ? ' active' : ''}`} disabled={it.disabled}
                    onClick={() => { more.close(); it.el.click(); }}>
                    <span class="pv-more-ico" innerHTML={it.icon}></span>
                    <span class="dd-item-label">{it.label}</span>
                  </button>
                ))}
            </For>
          </div>
        </Show>

        <span class="pv-spacer"></span>
        <Show when={previewFile()}><span class="pv-file">{previewFile()}</span></Show>
        <Show when={!IS_AUX_VIEWER}>
          <Btn icon={ic.close} title="Cerrar el visor PDF"
            onClick={() => { state.previewVisible = false; state.viewerMaximized = false; }} />
        </Show>
      </div>

      <Show when={pdfSearchOpen()}>
        <PdfSearchBar />
      </Show>

      <Show when={annotBarOpen()}>
        <AnnotBar />
      </Show>

      {/* The PDF belongs to another document. Not an error and not a reason to
          clear the viewer — but it has to be said, because reading one report's
          text beside another report's numbers is the kind of mistake that is
          only noticed much later. */}
      <Show when={state.pdfForeign && hasPdf() && !IS_AUX_VIEWER}>
        <div class="pv-foreign">
          <span class="pyx-ico" innerHTML={ICO.warn}></span>
          <span>
            Este PDF es de <b>{previewFile()}</b>, no del documento abierto.
            Compila (<b>Ctrl+Mayús+B</b>) para ver el suyo.
          </span>
        </div>
      </Show>

      <Show when={!hasPdf()}>
        <div class="preview-empty">
          <Show
            when={loadError()}
            fallback={IS_AUX_VIEWER
              ? 'Cargando el PDF…'
              : <>Compila el documento (<b>Compilar y ver</b> o <b>Ctrl+Shift+B</b>) para ver el PDF aquí.</>}
          >
            <span style={{ color: 'var(--theme-cell-error, #d16969)' }}>{loadError()}</span>
          </Show>
        </div>
      </Show>
      <div class="preview-body">
        <Show when={outlineOpen() && hasPdf()}>
          <PdfOutline />
        </Show>
        <div class={`preview-scroll tool-${tool()}${invert() ? ' pdf-invert' : ''}${annotTool() ? ` annot-active annot-tool-${annotTool()}` : ''}${TEXT_TOOLS.has(annotTool()) ? ' annot-text' : ''}`} ref={scrollRef}></div>
      </div>
    </>
  );
}
