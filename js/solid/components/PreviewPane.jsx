import { onMount, createSignal, createEffect, Show, For } from 'solid-js';
import { state } from '../../core/state.js';
import {
  setPreviewContainer, rerender, zoomBy, setZoom, setFit,
  goFirst, goPrev, goNext, goLast, goToPage, getPdfPath, pdfSearch, pdfFindNext,
} from '../../pdf/preview.js';
import {
  scale, numPages, currentPage, fitMode, tool, setTool, invert, setInvert, previewFile, hasPdf,
  pdfSearchOpen, setPdfSearchOpen, loadError, setAuxOpen,
  annotBarOpen, setAnnotBarOpen, annotTool, setAnnotTool, annotColor, setAnnotColor,
  annotWidth, setAnnotWidth,
} from '../stores/previewStore.js';
import { undoLast, clearPage } from '../../pdf/annotate.js';
import { openExternal, openViewerWindow, messageDialog } from '../../core/platform.js';

const S = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
const ic = {
  first: `<svg viewBox="0 0 20 20"><path ${S} d="M6 4v12M15 5l-6 5 6 5"/></svg>`,
  prev: `<svg viewBox="0 0 20 20"><path ${S} d="M13 5l-6 5 6 5"/></svg>`,
  next: `<svg viewBox="0 0 20 20"><path ${S} d="M7 5l6 5-6 5"/></svg>`,
  last: `<svg viewBox="0 0 20 20"><path ${S} d="M14 4v12M5 5l6 5-6 5"/></svg>`,
  zin: `<svg viewBox="0 0 20 20"><circle ${S} cx="9" cy="9" r="5"/><path ${S} d="M16 16l-3.5-3.5M9 6.8v4.4M6.8 9h4.4"/></svg>`,
  zout: `<svg viewBox="0 0 20 20"><circle ${S} cx="9" cy="9" r="5"/><path ${S} d="M16 16l-3.5-3.5M6.8 9h4.4"/></svg>`,
  fitW: `<svg viewBox="0 0 20 20"><path ${S} d="M3 10h14M6 7l-3 3 3 3M14 7l3 3-3 3"/></svg>`,
  fitH: `<svg viewBox="0 0 20 20"><path ${S} d="M10 3v14M7 6l3-3 3 3M7 14l3 3 3-3"/></svg>`,
  sel: `<svg viewBox="0 0 20 20"><path ${S} d="M5 3l11 5-5 1.5L9 16z"/></svg>`,
  pan: `<svg viewBox="0 0 20 20"><path ${S} d="M9 8V4.5a1.2 1.2 0 0 1 2.4 0V8m0-1a1.2 1.2 0 0 1 2.4 0v3m0-2a1.2 1.2 0 0 1 2.4 0v4a4 4 0 0 1-4 4h-2l-3-3-2.5-3a1.3 1.3 0 0 1 2-1.6L9 11"/></svg>`,
  mag: `<svg viewBox="0 0 20 20"><circle ${S} cx="9" cy="9" r="5.5"/><path ${S} d="M17 17l-4-4"/></svg>`,
  contrast: `<svg viewBox="0 0 20 20"><circle ${S} cx="10" cy="10" r="7"/><path d="M10 3a7 7 0 0 1 0 14z" fill="currentColor"/></svg>`,
  max: `<svg viewBox="0 0 20 20"><path ${S} d="M4 8V4h4M16 8V4h-4M4 12v4h4M16 12v4h-4"/></svg>`,
  float: `<svg viewBox="0 0 20 20"><path ${S} d="M9 4H4v12h12v-5M12 4h4v4M16 4l-7 7"/></svg>`,
  detach: `<svg viewBox="0 0 20 20"><rect ${S} x="3" y="6" width="10" height="10"/><path ${S} d="M7 6V3.5h9.5V13H14"/></svg>`,
  close: `<svg viewBox="0 0 20 20"><path ${S} d="M5 5l10 10M15 5L5 15"/></svg>`,
  find: `<svg viewBox="0 0 20 20"><circle ${S} cx="8.5" cy="8.5" r="5"/><path ${S} d="M16 16l-3.7-3.7"/><path ${S} d="M6.5 8.5h4M8.5 6.5v4" opacity="0"/></svg>`,
  draw: `<svg viewBox="0 0 20 20"><path ${S} d="M4 16l1-3.5L13 4.5l2.5 2.5L7.5 15z"/><path ${S} d="M11.5 6.5l2.5 2.5"/></svg>`,
  pen: `<svg viewBox="0 0 20 20"><path ${S} d="M4 16l1-3.5L13 4.5l2.5 2.5L7.5 15z"/><path ${S} d="M11.5 6.5l2.5 2.5"/></svg>`,
  marker: `<svg viewBox="0 0 20 20"><path ${S} d="M5 15l-1 2h4l-1-2M6 14l5.5-8.5 3 2L9 16z"/></svg>`,
  rect: `<svg viewBox="0 0 20 20"><rect ${S} x="4" y="5" width="12" height="10"/></svg>`,
  arrow: `<svg viewBox="0 0 20 20"><path ${S} d="M4 16L15 5M15 5h-5M15 5v5"/></svg>`,
  line: `<svg viewBox="0 0 20 20"><path ${S} d="M4 16L16 4"/></svg>`,
  noteText: `<svg viewBox="0 0 20 20"><path ${S} d="M5 4h10M10 4v12"/></svg>`,
  eraser: `<svg viewBox="0 0 20 20"><path ${S} d="M7 16l-3-3 7-7 3 3-7 7zM10 16h6"/></svg>`,
  undo: `<svg viewBox="0 0 20 20"><path ${S} d="M7 6L3 9l4 3M3 9h8a5 5 0 0 1 0 10H8"/></svg>`,
  trashAll: `<svg viewBox="0 0 20 20"><path ${S} d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/></svg>`,
};

const ANNOT_TOOLS = [
  { id: 'pen', icon: 'pen', title: 'Lápiz (dibujo libre)' },
  { id: 'highlight', icon: 'marker', title: 'Resaltador' },
  { id: 'line', icon: 'line', title: 'Línea recta' },
  { id: 'arrow', icon: 'arrow', title: 'Flecha' },
  { id: 'rect', icon: 'rect', title: 'Rectángulo' },
  { id: 'text', icon: 'noteText', title: 'Nota de texto' },
  { id: 'eraser', icon: 'eraser', title: 'Borrador (borra la anotación bajo el clic)' },
];
const ANNOT_COLORS = ['#e23b3b', '#f5a623', '#2ca24c', '#2f7fe0', '#9b51e0', '#1a1a1a'];

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
      <button class="pv-btn" title="Deshacer la última anotación" innerHTML={ic.undo} onClick={undoLast}></button>
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
      <span class="pdf-search-count">{total() ? `${pos()} de ${total()}` : 'Sin resultados'}</span>
      <button title="Anterior (Shift+Enter)" onClick={() => step(-1)}>↑</button>
      <button title="Siguiente (Enter)" onClick={() => step(1)}>↓</button>
      <button title="Cerrar (Esc)" onClick={close}>✕</button>
    </div>
  );
}

export default function PreviewPane() {
  let scrollRef;
  onMount(() => setPreviewContainer(scrollRef));

  const floatWindow = () => { const p = getPdfPath(); if (p) openExternal(p); };
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

  const Btn = (p) => (
    <button class={`pv-btn${p.active ? ' active' : ''}`} title={p.title} disabled={p.disabled}
      onClick={p.onClick} innerHTML={p.icon}></button>
  );

  return (
    <>
      <div class="preview-toolbar">
        <Btn icon={ic.first} title="Primera página" onClick={goFirst} />
        <Btn icon={ic.prev} title="Página anterior" onClick={goPrev} />
        <div class="pv-page">
          <input type="text" value={currentPage()} onChange={onPageInput} />
          <span>/ {numPages() || 0}</span>
        </div>
        <Btn icon={ic.next} title="Página siguiente" onClick={goNext} />
        <Btn icon={ic.last} title="Última página" onClick={goLast} />

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
        <Btn icon={ic.find} title="Buscar en el PDF (Ctrl+F)" active={pdfSearchOpen()}
          disabled={!hasPdf()} onClick={() => setPdfSearchOpen(!pdfSearchOpen())} />
        <Btn icon={ic.draw} title="Anotar / dibujar sobre el PDF" active={annotBarOpen()}
          disabled={!hasPdf()}
          onClick={() => { const o = !annotBarOpen(); setAnnotBarOpen(o); setAnnotTool(o ? 'pen' : ''); }} />
        <Btn icon={ic.contrast} title="Contraste — folio gris (modo noche)" active={invert()} onClick={() => setInvert(!invert())} />
        <Btn icon={ic.max} title="Ampliar visor (ocultar el editor)" active={state.viewerMaximized}
          onClick={() => (state.viewerMaximized = !state.viewerMaximized)} />
        <Btn icon={ic.detach} title="Sacar el visor de Pyx a una ventana auxiliar" disabled={!hasPdf()} onClick={detachViewer} />
        <Btn icon={ic.float} title="Abrir el PDF en la aplicación externa" disabled={!hasPdf()} onClick={floatWindow} />

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
      <div class={`preview-scroll tool-${tool()}${invert() ? ' pdf-invert' : ''}${annotTool() ? ' annot-active' : ''}`} ref={scrollRef}></div>
    </>
  );
}
