import { createSignal } from 'solid-js';

export const [scale, setScale] = createSignal(1.25);
export const [numPages, setNumPages] = createSignal(0);
export const [currentPage, setCurrentPage] = createSignal(1);
export const [fitMode, setFitMode] = createSignal('width'); // none | width | page | text
export const [tool, setTool] = createSignal('select'); // select | pan | magnify
export const [invert, setInvert] = createSignal(false); // dark "night mode" folio
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
