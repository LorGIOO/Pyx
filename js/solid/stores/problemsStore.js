// The last compile's problems (errors, warnings, bad boxes), parsed ONCE and
// shared.
//
// The list used to be a memo private to the log panel (EditorPane). The
// compile LED needs the same list — its tooltip quotes the first error and a
// click on it goes there — and so does the status bar's wording; three
// parsers of the same log would be three chances to disagree about what the
// first error is.
//
// This module stays light on purpose (no editor, no document store at import
// time): the pure helpers below are unit-tested without a browser.

import { createRoot, createMemo } from 'solid-js';
import { state } from '../../core/state.js';
import { parseLatexLog } from '../../compile/log-parser.js';
import {
  lineMaps, buildToReal, knownFileSet, rootBuildFile, projectRoot,
} from '../../compile/build-maps.js';
import { baseName, joinPath, relativeTo, samePath } from '../../core/paths.js';

// TeXstudio-fidelity parse: file attribution via the log's parenthesis stack,
// with Pyx's .build copies mapped back to the real files. The build maps are
// plain module data (not reactive); they are always set before the log that
// refers to them, so re-parsing on a new `lastLog` is enough.
export const problems = createRoot(() => createMemo(() => parseLatexLog(state.lastLog, {
  rootFile: rootBuildFile(),
  buildMap: buildToReal(),
  knownFiles: knownFileSet(),
  // The builds are clean LaTeX (cells removed): translate engine line
  // numbers back to source lines so clicks land on the right line.
  lineMaps: lineMaps(),
})));

/** The first ERROR of a problem list (warnings and bad boxes do not count). */
export function firstError(list) {
  return (list || []).find((p) => p && p.severity === 'error') || null;
}

const isAbsolute = (p) => /^([a-zA-Z]:[\\/]|[\\/])/.test(p);

/**
 * Which document a problem belongs to. Pure.
 *
 * A problem's `line` is a line of ITS file. The log panel used to jump to
 * that line in whatever document happened to be in front, so an error in
 * line 12 of a chapter sent the cursor to line 12 of the main file.
 *
 * @param {{file?: string|null}} p
 * @param {object} ctx
 * @param {Array<{path?: string|null, fileName?: string}>} ctx.documents  open documents
 * @param {string|null} ctx.projectDir   folder of the last compiled project
 * @param {Set<string>} ctx.knownFiles   lowercase basenames of its files
 * @param {string[]}    ctx.sourceFiles  real paths of its sources
 * @returns {{kind: 'active'} | {kind: 'open', index: number}
 *          | {kind: 'path', path: string} | {kind: 'foreign'}}
 *   active   no file recorded (a Pyx notice): the document in front
 *   open     an already open document
 *   path     a project file to open
 *   foreign  not a file of this project (a package, a class): the line means
 *            nothing in any document we could show — do not jump anywhere
 */
export function resolveProblemFile(p, ctx = {}) {
  if (!p || !p.file) return { kind: 'active' };
  const file = String(p.file);
  const docs = ctx.documents || [];
  const base = baseName(file).toLowerCase();
  const sources = ctx.sourceFiles || [];
  const known = ctx.knownFiles || new Set();

  if (isAbsolute(file)) {
    const i = docs.findIndex((d) => d && d.path && samePath(d.path, file));
    if (i >= 0) return { kind: 'open', index: i };
    const ours = sources.some((s) => samePath(s, file))
      || (!!ctx.projectDir && relativeTo(ctx.projectDir, file) != null && known.has(base));
    return ours ? { kind: 'path', path: file } : { kind: 'foreign' };
  }

  // A bare or relative name, as TeX printed it. An open document with that
  // name wins — preferring the one inside the project when two share a name.
  const named = [];
  docs.forEach((d, i) => {
    const n = (d && (d.path ? baseName(d.path) : d.fileName)) || '';
    if (n.toLowerCase() === base) named.push(i);
  });
  if (named.length) {
    const inProject = ctx.projectDir
      ? named.find((i) => docs[i].path && samePath(joinPath(ctx.projectDir, file), docs[i].path))
      : undefined;
    return { kind: 'open', index: inProject ?? named[0] };
  }
  const src = sources.find((s) => baseName(s).toLowerCase() === base);
  if (src) return { kind: 'path', path: src };
  if (ctx.projectDir && known.has(base)) return { kind: 'path', path: joinPath(ctx.projectDir, file) };
  return { kind: 'foreign' };
}

/**
 * Show a problem in the editor: bring ITS file to the front (opening it if
 * needed), then put the cursor on its line. Resolves to false when there is
 * nowhere to go (a problem inside a package).
 */
export async function gotoProblem(p) {
  if (!p) return false;
  const target = resolveProblemFile(p, {
    documents: state.documents,
    projectDir: projectRoot(),
    knownFiles: knownFileSet(),
    sourceFiles: Object.values(buildToReal() || {}),
  });
  if (target.kind === 'foreign') return false;
  // Loaded on demand: the document store and the editor commands import half
  // the application, and this module is also what the unit tests load.
  const [{ openPath, switchTo }, { gotoLine }] = await Promise.all([
    import('./docStore.js'),
    import('../../editor/commands.js'),
  ]);
  if (target.kind === 'open') {
    if (target.index !== state.activeIndex) switchTo(target.index);
  } else if (target.kind === 'path') {
    await openPath(target.path);
    const front = state.documents[state.activeIndex];
    // openPath reports its own failure (a dialog); just do not jump to a
    // line of the wrong file.
    if (!front || !front.path || !samePath(front.path, target.path)) return false;
  }
  // One frame later: the pane shows the document from an effect.
  if (p.line) requestAnimationFrame(() => gotoLine(p.line));
  return true;
}
