// Inline SVG icons for the ribbon, the title bar and the side strip.
//
// House style (same hand as the notebook-cell icons in js/editor/cells.js and
// as VSCode's codicons): a 16x16 box, 1.2px strokes, round caps and joins, no
// fills unless the shape IS a solid (stop, half-disc). Each comment names the
// codicon the shape is modelled on; where the codicon set has no equivalent
// (LaTeX-specific tools) it says so.
//
// The stroke lives on the <svg> ROOT, never on the children: ribbon.css sets
// `.ribbon-btn-icon svg { stroke: var(--theme-ribbon-icon-stroke) }` and swaps
// it on :hover/.active/.busy. A CSS declaration beats a presentation attribute
// on the same element, so the theme wins on the root and the children inherit
// it — which is why the icons now light up with the button instead of staying
// the same grey as before.
const A = 'viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"';
const svg = (body) => `<svg ${A}>${body}</svg>`;
// A round dot in the stroke colour: a zero-length path with a round cap. Keeps
// bullets inheriting the same colour as the rest of the icon (a `fill` would
// not follow the hover/active stroke).
const dot = (x, y, w = 2) => `<path d="M${x} ${y}h.01" stroke-width="${w}"/>`;

export const icons = {
  /* ---- file (codicon: new-file, folder-opened, save, save-as, folder) ---- */
  newDoc: svg('<path d="M9 1.5H3.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h3.7"/><path d="M9 1.5 12.5 5v2.6"/><path d="M9 1.5V5h3.5"/><path d="M12 9.6v4.9M9.6 12h4.9"/>'),
  open: svg('<path d="M1.5 12V3.4a.9.9 0 0 1 .9-.9h3.2l1.6 1.7h5.3a.9.9 0 0 1 .9.9v1.4"/><path d="M2.6 13.5h9.5l2.3-5.5a.6.6 0 0 0-.6-.8H4.7a.6.6 0 0 0-.6.4l-2.1 5.1a.6.6 0 0 0 .6.8z"/>'),
  save: svg('<path d="M2.5 3.4a.9.9 0 0 1 .9-.9h7.3l2.8 2.8v7.3a.9.9 0 0 1-.9.9H3.4a.9.9 0 0 1-.9-.9z"/><path d="M5.2 2.5v3.3h5.1V2.5"/><path d="M4.8 13.5V9.3h6.4v4.2"/>'),
  saveAs: svg('<path d="M2.5 3.4a.9.9 0 0 1 .9-.9h6.9l2.6 2.6v2.7"/><path d="M2.5 3.4v9.2a.9.9 0 0 0 .9.9h3.5"/><path d="M5.2 2.5v3.3h4.6V2.5"/><path d="m13.2 8.4 1.4 1.4-4.2 4.2-1.9.5.5-1.9z"/>'),
  folder: svg('<path d="M1.5 12.6V3.4a.9.9 0 0 1 .9-.9h3.2l1.6 1.7h6.4a.9.9 0 0 1 .9.9v7.5a.9.9 0 0 1-.9.9H2.4a.9.9 0 0 1-.9-.9z"/>'),

  /* ---- edit (codicon: discard, redo, copy, clippy, search) ---- */
  undo: svg('<path d="M2.5 6.4h7a3.8 3.8 0 0 1 0 7.6H6"/><path d="M5.6 3.3 2.5 6.4l3.1 3.1"/>'),
  redo: svg('<path d="M13.5 6.4h-7a3.8 3.8 0 0 0 0 7.6H10"/><path d="m10.4 3.3 3.1 3.1-3.1 3.1"/>'),
  // No codicon equivalent (VSCode leaves cut/copy/paste to the native menus).
  cut: svg('<circle cx="4.2" cy="11.9" r="1.9"/><circle cx="11.8" cy="11.9" r="1.9"/><path d="M5.5 10.5 12 2.3M10.5 10.5 4 2.3"/>'),
  copy: svg('<rect x="5.5" y="5.5" width="9" height="9" rx="1"/><path d="M11 3.6V2.4a.9.9 0 0 0-.9-.9H2.4a.9.9 0 0 0-.9.9v7.7a.9.9 0 0 0 .9.9h1.2"/>'),
  paste: svg('<path d="M5.6 2.5H4a.9.9 0 0 0-.9.9v10.2a.9.9 0 0 0 .9.9h8a.9.9 0 0 0 .9-.9V3.4a.9.9 0 0 0-.9-.9h-1.6"/><rect x="5.6" y="1.5" width="4.8" height="2.4" rx=".7"/>'),
  find: svg('<circle cx="7" cy="7" r="4.5"/><path d="m10.3 10.3 4.2 4.2"/>'),

  /* ---- structure / insert (codicon: list-flat, symbol-operator, table,
     file-media, list-unordered, list-ordered) ---- */
  section: svg('<path d="M2.5 3.5h11M2.5 8h7.5M2.5 12.5h11"/>'),
  math: svg('<path d="M11.6 3.6V2.5H4.5L8.2 8l-3.7 5.5h7.1v-1.1"/>'),
  /* Representative math tool icons: real glyph previews, not generic shapes.
     Text is the point here, so these keep a fill — it matches the icon stroke
     colour in every theme (--theme-ribbon-text === --theme-ribbon-icon-stroke). */
  mFrac: `<svg ${A}><text x="8" y="6.6" text-anchor="middle" font-size="6.4" font-style="italic" font-family="Georgia,serif" fill="currentColor" stroke="none">a</text><path d="M4 8h8"/><text x="8" y="14.4" text-anchor="middle" font-size="6.4" font-style="italic" font-family="Georgia,serif" fill="currentColor" stroke="none">b</text></svg>`,
  mSqrt: `<svg ${A}><path d="m1.5 9.5 1.8 3.4L5.8 4H14.5"/><text x="10" y="12" text-anchor="middle" font-size="6.6" font-style="italic" font-family="Georgia,serif" fill="currentColor" stroke="none">x</text></svg>`,
  mSup: `<svg ${A}><text x="5.4" y="12.4" text-anchor="middle" font-size="10" font-style="italic" font-family="Georgia,serif" fill="currentColor" stroke="none">x</text><text x="11.6" y="6.4" text-anchor="middle" font-size="7" font-family="Georgia,serif" fill="currentColor" stroke="none">2</text></svg>`,
  mSub: `<svg ${A}><text x="5.4" y="10.8" text-anchor="middle" font-size="10" font-style="italic" font-family="Georgia,serif" fill="currentColor" stroke="none">x</text><text x="11.6" y="14.4" text-anchor="middle" font-size="7" font-family="Georgia,serif" fill="currentColor" stroke="none">2</text></svg>`,
  mInline: `<svg ${A}><text x="8" y="11" text-anchor="middle" font-size="7.4" font-family="Georgia,serif" fill="currentColor" stroke="none">$x$</text></svg>`,
  mDisplay: `<svg ${A}><path d="M3.2 3v10M2 3h2.4M2 13h2.4M12.8 3v10M11.6 3H14M11.6 13H14"/><text x="8" y="10.6" text-anchor="middle" font-size="7" font-style="italic" font-family="Georgia,serif" fill="currentColor" stroke="none">x</text></svg>`,
  mArray: `<svg ${A}><path d="M3.6 2.6v10.8M12.4 2.6v10.8"/>${dot(6.4, 5.8)}${dot(9.6, 5.8)}${dot(6.4, 10.2)}${dot(9.6, 10.2)}</svg>`,
  table: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M1.5 6h13M1.5 9.8h13M6 6v7.5M10.2 6v7.5"/>'),
  image: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><circle cx="5.4" cy="6.2" r="1.2"/><path d="m1.9 12.7 3.8-3.8 2.6 2.6 2.1-2.1 3.3 3.3"/>'),
  list: svg(`<path d="M5.6 3.5h8.9M5.6 8h8.9M5.6 12.5h8.9"/>${dot(2.6, 3.5)}${dot(2.6, 8)}${dot(2.6, 12.5)}`),

  /* ---- cells / Python (codicon: notebook, play, run-all, debug-stop,
     debug-restart, debug-rerun, trash, eye-closed) ---- */
  cell: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M4.8 6.1 7.4 8l-2.6 1.9z"/><path d="M9.2 9.9h2.6"/>'),
  run: svg('<path d="M4.6 2.9v10.2L13.2 8z"/>'),
  runAll: svg('<path d="M2.6 3.4v9.2L8 8z"/><path d="M8.4 3.4v9.2L13.8 8z"/>'),
  stop: svg('<rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.2" fill="currentColor" stroke="none"/>'),
  // No codicon equivalent: VSCode shows the Python language icon here.
  python: svg(`<path d="M6 3.1h4v2.7H6A1.6 1.6 0 0 0 4.4 7.4v.3"/><path d="M10 12.9H6v-2.7h4a1.6 1.6 0 0 0 1.6-1.6v-.3"/>${dot(7.1, 4.4, 1.6)}${dot(8.9, 11.6, 1.6)}`),
  restart: svg('<path d="M13.5 8a5.5 5.5 0 1 1-1.9-4.2"/><path d="M13.6 2.2v3.4h-3.4"/>'),
  live: svg('<path d="M13.5 8A5.5 5.5 0 1 0 8 13.5"/><path d="M13.6 4.6V8h-3.4"/><path d="M6.4 6.1v3.8L9.6 8z"/>'),
  clear: svg('<path d="M3 4h10M6 4V2.7h4V4M5 4l.7 9h4.6L11 4z"/>'),
  eyeOff: svg('<path d="M1.2 8S3.8 4 8 4s6.8 4 6.8 4-2.6 4-6.8 4S1.2 8 1.2 8z"/><circle cx="8" cy="8" r="1.9"/><path d="M2.6 2.6 13.4 13.4"/>'),

  /* ---- view / panels (codicon: terminal, layout-sidebar-left,
     split-horizontal, screen-full, open-preview, output) ---- */
  terminal: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="m4.4 6.2 2.2 2.2-2.2 2.2M8.4 10.8h3.4"/>'),
  sidebar: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M6 2.5v11"/>'),
  splitV: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M8 2.5v11"/>'),
  zen: svg('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
  preview: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M1.5 5.6h13"/><circle cx="7.6" cy="9.5" r="2.1"/><path d="m9.2 11.1 1.7 1.7"/>'),
  log: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M4.2 6h7.6M4.2 8.5h7.6M4.2 11h4.6"/>'),

  /* ---- compile / PDF (codicon: run, file-pdf, zoom-in, zoom-out) ---- */
  compile: svg('<path d="M9 1.5H3.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.2z"/><path d="M9 1.5v3.7h3.5"/><path d="M6.4 8.3v3.6L9.6 10z"/>'),
  pdf: svg('<path d="M9 1.5H3.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.2z"/><path d="M9 1.5v3.7h3.5"/><path d="M5.6 12.2V8.5h1.6a1.2 1.2 0 0 1 0 2.4H5.6"/>'),
  zoomIn: svg('<circle cx="6.8" cy="6.8" r="4.4"/><path d="m10.1 10.1 4.4 4.4M6.8 4.7v4.2M4.7 6.8h4.2"/>'),
  zoomOut: svg('<circle cx="6.8" cy="6.8" r="4.4"/><path d="m10.1 10.1 4.4 4.4M4.7 6.8h4.2"/>'),

  /* ---- misc (codicon: color-mode, question, gear) ---- */
  theme: svg('<circle cx="8" cy="8" r="5.6"/><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor" stroke="none"/>'),
  help: svg(`<circle cx="8" cy="8" r="6"/><path d="M6.1 6.3a1.9 1.9 0 1 1 2.6 1.8c-.6.3-.7.7-.7 1.3"/>${dot(8, 11.6, 1.6)}`),
  gear: svg('<circle cx="8" cy="8" r="2.1"/><path d="M8 1.5h0l.5 1.8 1.7.7 1.6-.9 1.1 1.1-.9 1.6.7 1.7 1.8.5v1.6l-1.8.5-.7 1.7.9 1.6-1.1 1.1-1.6-.9-1.7.7-.5 1.8H7.2l-.5-1.8-1.7-.7-1.6.9-1.1-1.1.9-1.6-.7-1.7-1.8-.5V7.2l1.8-.5.7-1.7-.9-1.6 1.1-1.1 1.6.9 1.7-.7L7.2 1.5z"/>'),

  /* ---- text formatting (codicon: bold, italic, case-sensitive) ---- */
  bold: svg('<path d="M4.6 2.5h4.1a2.7 2.7 0 0 1 0 5.4H4.6zM4.6 7.9h4.8a2.8 2.8 0 0 1 0 5.6H4.6z"/>'),
  italic: svg('<path d="M9.9 2.5H6.6M9.4 13.5H6.1M10.4 2.5 5.6 13.5"/>'),
  // No codicon equivalent (underline/strikethrough are not in the set).
  underline: svg('<path d="M4.4 2.5v4.8a3.6 3.6 0 0 0 7.2 0V2.5M3.4 13.5h9.2"/>'),
  strike: svg('<path d="M2.5 8h11"/><path d="M5.2 5.6C5.2 3.8 6.5 3 8 3s2.8.8 2.8 2.4"/><path d="M5.2 10.4c0 1.8 1.3 2.6 2.8 2.6s2.8-.8 2.8-2.6"/>'),
  // x² / x₂ drawn with strokes so they follow the icon colour like the rest.
  sup: svg('<path d="m1.9 6.2 5 6.6M6.9 6.2l-5 6.6"/><path d="M9.7 4.4a1.4 1.4 0 0 1 2.7.5c0 1.2-2.7 2-2.7 3h2.9"/>'),
  sub: svg('<path d="m1.9 3.2 5 6.6M6.9 3.2l-5 6.6"/><path d="M9.7 10.1a1.4 1.4 0 0 1 2.7.5c0 1.2-2.7 2-2.7 3h2.9"/>'),
  caseAa: svg('<path d="m1.5 12.4 3-8 3 8M2.6 9.8h3.8"/><circle cx="11.2" cy="9.9" r="2.4"/><path d="M13.6 7.5v4.9"/>'),
  // No codicon equivalent (paragraph alignment lives in the Markdown tools).
  alignLeft: svg('<path d="M2 3.5h12M2 6.8h7.5M2 10.1h12M2 13.4h7.5"/>'),
  alignCenter: svg('<path d="M2 3.5h12M4.2 6.8h7.5M2 10.1h12M4.2 13.4h7.5"/>'),
  alignRight: svg('<path d="M2 3.5h12M6.5 6.8h7.5M2 10.1h12M6.5 13.4h7.5"/>'),
  bullets: svg(`<path d="M5.6 3.5h8.9M5.6 8h8.9M5.6 12.5h8.9"/>${dot(2.6, 3.5)}${dot(2.6, 8)}${dot(2.6, 12.5)}`),
  numbered: svg('<path d="M5.6 3.5h8.9M5.6 8h8.9M5.6 12.5h8.9"/><g stroke-width=".95"><path d="m1.6 2.6 1-.7v2.9"/><path d="M1.4 7a1.1 1.1 0 0 1 2.1.4c0 .9-2.1 1.5-2.1 2.3h2.2"/><path d="M1.4 11.6a1.1 1.1 0 0 1 2 .6c0 .5-.5.7-.9.7.5 0 1 .3 1 .8a1.1 1.1 0 0 1-2.1.4"/></g>'),
  brackets: svg('<path d="M6 2.5H3.4v11H6M10 2.5h2.6v11H10"/>'),

  /* ---- table tools (no codicon equivalents: TeXstudio-style) ---- */
  tblAddRow: svg('<rect x="1.5" y="2.5" width="13" height="6.6" rx="1"/><path d="M1.5 5.8h13M8 2.5v6.6"/><path d="M11.6 11v4M9.6 13h4"/>'),
  tblAddCol: svg('<rect x="2.5" y="1.5" width="6.6" height="13" rx="1"/><path d="M5.8 1.5v13M2.5 8h6.6"/><path d="M13 9.6v4M11 11.6h4"/>'),
  tblDelRow: svg('<rect x="1.5" y="2.5" width="13" height="6.6" rx="1"/><path d="M1.5 5.8h13M8 2.5v6.6"/><path d="M9.6 13h4"/>'),
  tblDelCol: svg('<rect x="2.5" y="1.5" width="6.6" height="13" rx="1"/><path d="M5.8 1.5v13M2.5 8h6.6"/><path d="M11 11.6h4"/>'),
  tblHline: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M6 2.5v11M10.2 2.5v11"/><path d="M1.5 8h13" stroke-width="2.1"/>'),
  tblAlign: svg('<rect x="4" y="2.5" width="8" height="11" rx="1"/><path d="M5.8 5.6h4.4M5.4 8h5.2M6.2 10.4h3.6"/>'),
  ruler: svg('<rect x="1.5" y="5.5" width="13" height="5" rx="1"/><path d="M4.2 5.5v2M6.9 5.5v2.8M9.6 5.5v2M12.3 5.5v2.8"/>'),

  /* ---- cells: collapse / expand all (codicon: collapse-all, expand-all) ---- */
  collapseAll: svg('<path d="M2.5 8h11"/><path d="M5.2 5.3 8 2.5l2.8 2.8M5.2 10.7 8 13.5l2.8-2.8"/>'),
  expandAll: svg('<path d="M2.5 8h11"/><path d="M5.2 3.3 8 6.1l2.8-2.8M5.2 12.7 8 9.9l2.8 2.8"/>'),

  /* ---- small chrome glyphs used outside the ribbon (codicon: close, add,
     chevron-down, chevron-right, refresh, new-file, new-folder, pass, error,
     debug-pause, arrow-up, arrow-down, discard, gear) ---- */
  close: svg('<path d="m3.6 3.6 8.8 8.8M12.4 3.6l-8.8 8.8"/>'),
  add: svg('<path d="M8 3v10M3 8h10"/>'),
  chevronDown: svg('<path d="m4 6 4 4 4-4" stroke-width="1.4"/>'),
  chevronRight: svg('<path d="m6 4 4 4-4 4" stroke-width="1.4"/>'),
  refresh: svg('<path d="M13.5 8a5.5 5.5 0 1 1-1.9-4.2"/><path d="M13.6 2.2v3.4h-3.4"/>'),
  newFile: svg('<path d="M9 1.5H3.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h3.7"/><path d="M9 1.5 12.5 5v2.6"/><path d="M9 1.5V5h3.5"/><path d="M12 9.6v4.9M9.6 12h4.9"/>'),
  newFolder: svg('<path d="M14.5 8.2V5.1a.9.9 0 0 0-.9-.9H7.2L5.6 2.5H2.4a.9.9 0 0 0-.9.9v9.2a.9.9 0 0 0 .9.9h4.4"/><path d="M12 9.6v4.9M9.6 12h4.9"/>'),
  pass: svg('<circle cx="8" cy="8" r="6"/><path d="m5.2 8.1 2 2 3.6-4.2"/>'),
  error: svg('<circle cx="8" cy="8" r="6"/><path d="m5.7 5.7 4.6 4.6M10.3 5.7l-4.6 4.6"/>'),
  pause: svg('<path d="M6 3.4v9.2M10 3.4v9.2"/>'),
  arrowUp: svg('<path d="M8 13V3.4M4.4 7 8 3.4 11.6 7"/>'),
  arrowDown: svg('<path d="M8 3v9.6M4.4 9 8 12.6 11.6 9"/>'),
  discard: svg('<path d="M2.5 6.4h7a3.8 3.8 0 0 1 0 7.6H6"/><path d="M5.6 3.3 2.5 6.4l3.1 3.1"/>'),
  circleSlash: svg('<circle cx="8" cy="8" r="5.6"/><path d="m4 12 8-8"/>'),

  /* ---- context menus (codicon: check, trash, book, list-selection,
          split-vertical, ellipsis, replace) ---- */
  check: svg('<path d="m3.5 8.4 3.1 3.1 5.9-6.6" stroke-width="1.5"/>'),
  trash: svg('<path d="M2.5 4.2h11M6 4.2V2.6h4v1.6M4.6 4.2l.7 9.3h5.4l.7-9.3"/>'),
  book: svg('<path d="M2.5 3.1a1 1 0 0 1 1-1H7a1.4 1.4 0 0 1 1 1.3v9.8a1.1 1.1 0 0 0-1-.7H2.5z"/><path d="M13.5 3.1a1 1 0 0 0-1-1H9a1.4 1.4 0 0 0-1 1.3v9.8a1.1 1.1 0 0 1 1-.7h4.5z"/>'),
  selectAll: svg('<path d="M2.5 4.6V3.4a.9.9 0 0 1 .9-.9h1.2M10.4 2.5h1.2a.9.9 0 0 1 .9.9v1.2M12.5 10.4v1.2a.9.9 0 0 1-.9.9h-1.2M5.6 13.5H4.4a.9.9 0 0 1-.9-.9v-1.2"/><path d="M6.2 2.5h2.6M13.5 6.2v2.6M9.8 13.5H7.2M2.5 9.8V7.2"/>'),
  splitCell: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="1.2"/><path d="M2.5 8h11"/>'),
  ellipsis: svg('<path d="M4 8h.01M8 8h.01M12 8h.01" stroke-width="2"/>'),
  replace: svg('<path d="M2.5 4.5h6.2M2.5 8h4.4M2.5 11.5h6.2"/><path d="M11.3 3.2v6.6M9.1 7.6l2.2 2.2 2.2-2.2"/>'),
  /* codicon: warning */
  warn: svg('<path d="M7.1 2.4 1.6 12a1 1 0 0 0 .9 1.5h11a1 1 0 0 0 .9-1.5L8.9 2.4a1 1 0 0 0-1.8 0z"/><path d="M8 6v3.2M8 11.3h.01" stroke-width="1.5"/>'),
};
