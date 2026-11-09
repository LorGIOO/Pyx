// The document id an EditorState belongs to.
//
// Cell outputs are shared across panes but MUST NOT be shared across
// documents: two files that both start with a cell would otherwise show each
// other's results. Every state carries its document id as a facet so the
// output store can namespace by it.

import { Facet, Annotation } from '@codemirror/state';

// Marks a transaction that MIRRORS an edit made in a sibling pane showing the
// same document (setup.js forwards them so the panes never diverge). Here —
// not in setup.js — so extensions can tell the edit from its echo without
// importing the module that imports them.
export const syncAnnotation = Annotation.define();

export const docIdFacet = Facet.define({
  combine: (values) => (values.length ? values[0] : 0),
});

export const docIdOf = (state) => state.facet(docIdFacet);
