// Indentation guides — faint vertical lines at each indent level, TeXstudio /
// VSCode-style, with the block holding the caret drawn in the accent colour.
//
// @replit/codemirror-indentation-markers (MIT, the same family as the
// minimap) replaced 134 lines of our own: it handles tabs, blank lines inside
// a block and scrolling, and adds the active-block highlight. Colours follow
// the theme through its CSS variables.

import { indentationMarkers } from '@replit/codemirror-indentation-markers';

const guide = 'var(--pyx-indent-guide)';
const active = 'var(--theme-accent)';

export const indentGuides = indentationMarkers({
  highlightActiveBlock: true,
  hideFirstIndent: false,
  markerType: 'fullScope',
  thickness: 1,
  activeThickness: 1,
  colors: { light: guide, dark: guide, activeLight: active, activeDark: active },
});
