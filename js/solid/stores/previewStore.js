import { createSignal } from 'solid-js';

// Viewer defaults come from Configuración → Visor PDF. Read straight from
// localStorage (not from settingsStore) so this module stays free of imports:
// preview.js sits in an import cycle with the editor and must load first.
function saved(key, fallback) {
  try {
    const g = JSON.parse(localStorage.getItem('calc-general') || '{}');
    return g[key] === undefined ? fallback : g[key];
  } catch (_) { return fallback; }
}

export const [scale, setScale] = createSignal(+saved('pdfZoom', 1.25) || 1.25);
export const [numPages, setNumPages] = createSignal(0);
export const [currentPage, setCurrentPage] = createSignal(1);
// none | width | height | page | text
export const [fitMode, setFitMode] = createSignal(saved('pdfFit', 'width'));
export const [tool, setTool] = createSignal('select'); // select | pan | magnify
export const [invert, setInvert] = createSignal(saved('pdfInvert', false) === true); // night-mode folio
export const [previewFile, setPreviewFile] = createSignal('');
export const [hasPdf, setHasPdf] = createSignal(false);
// Last PDF load failure, shown in the viewer instead of a silent blank pane.
export const [loadError, setLoadError] = createSignal('');
// Whether the detached viewer window is open: compiles then update THAT window
// and the in-app pane stays closed until the auxiliary window is closed.
export const [auxOpen, setAuxOpen] = createSignal(false);

// Focus-aware search: Ctrl+F targets wherever the user last interacted.
export const [lastArea, setLastArea] = createSignal('editor'); // 'editor' | 'pdf'
export const [pdfSearchOpen, setPdfSearchOpen] = createSignal(false);
// Progress (0..1) of building the PDF's text index. Searching a thousand-page
// document has to parse every page, so it reports progress instead of freezing.
// 0 = idle or finished.
export const [searchProgress, setSearchProgress] = createSignal(0);

// PDF annotation layer (drawing tools): which tool is active, the stroke color
// and width, and whether the annotation toolbar is shown. Empty tool = off
// (the page behaves normally: text selection, links, pan…).
export const [annotBarOpen, setAnnotBarOpen] = createSignal(false);
export const [annotTool, setAnnotTool] = createSignal(''); // '' | pen | highlight | rect | arrow | line | text | eraser
export const [annotColor, setAnnotColor] = createSignal('#e23b3b');
export const [annotWidth, setAnnotWidth] = createSignal(2);

export const getScale = () => scale();
export const getFitMode = () => fitMode();

// kept for older imports
export const setPages = setNumPages;
