// The few places the editor core calls into a shared session. Kept in a
// module with NO imports, so editor/setup.js can use it without pulling the
// collaboration layer (and its cycle back into the editor) in.
//
//   local(docId, changes, startDoc)  an edit typed here: send it out
//   filter(docId, tr) → bool         may this local edit be made? (permissions)
//   modified(docId) → bool           should this document show as unsaved?

//   selection(docId, view)           the caret moved (presence)
//   save(doc, opts)                  a collaborator's tab was "saved"
//   closed(doc)                      a tab was closed
//   shared(docId) → bool             is this document part of a session?
//   compile(showViewer) → bool       true = handled (a guest asks the host)
//   compileTarget() → doc|null       host: what a session compile builds
//   pdf(path)                        host: a compile produced this PDF
//   compileDone()                    host: a compile finished
//   restricted() → folder|false      host: compile with LaTeX locked down (shared folder)
//   lockMode(paranoid)               host: engine lock for this compile
//   synctexEdit(page, x, y)          guest: PDF → source, asked to the host
//   synctexView(doc, line)           guest: source → PDF, asked to the host

export const collabHooks = {
  local: null,
  filter: null,
  modified: null,
  selection: null,
  save: null,
  closed: null,
  shared: null,
  compile: null,
  compileTarget: null,
  pdf: null,
  compileDone: null,
  restricted: null,
  lockMode: null,
  synctexEdit: null,
  synctexView: null,
};
