// The document id an EditorState belongs to.
//
// Cell outputs are shared across panes but MUST NOT be shared across
// documents: two files that both start with a cell would otherwise show each
// other's results. Every state carries its document id as a facet so the
// output store can namespace by it.

import { Facet } from '@codemirror/state';

export const docIdFacet = Facet.define({
  combine: (values) => (values.length ? values[0] : 0),
});

export const docIdOf = (state) => state.facet(docIdFacet);
