// Build ↔ source line maps, kept OUT of the reactive store.
//
// The engine compiles `<stem>.build.tex`, a CLEAN LaTeX copy with the Python
// cells removed. Every removed line shifts what follows, so SyncTeX (both
// directions) and the log parser have to translate through a per-file map.
//
// These maps are arrays with one entry per build line — tens of thousands of
// integers on a real project. They used to live on the `createMutable` app
// state, which wraps everything it holds in a Proxy: each of those integers was
// then read through a proxy trap, in loops, on every SyncTeX click and every
// log parse. They are plain data that nothing renders, so they belong here.

/** build basename (lowercase) -> srcLines[] */
let maps = Object.create(null);
/** build basename (lowercase) -> real source path */
let buildMap = Object.create(null);
/** basenames (lowercase) of every file in the last compiled project */
let knownFiles = new Set();
/** basename of the root build file */
let rootFile = null;

export function setBuildMaps({ lineMaps, buildToReal, known, root }) {
  maps = lineMaps || Object.create(null);
  buildMap = buildToReal || Object.create(null);
  knownFiles = known || new Set();
  rootFile = root || null;
}

export const lineMaps = () => maps;
export const buildToReal = () => buildMap;
export const knownFileSet = () => knownFiles;
export const rootBuildFile = () => rootFile;

/** The line map for a real source path (`.tex`/`.pltx`), or null. */
export function lineMapFor(realPath) {
  if (!realPath) return null;
  const base = (String(realPath).split(/[\\/]/).pop() || '')
    .replace(/\.(tex|pltx)$/i, '')
    .toLowerCase() + '.build.tex';
  return maps[base] || null;
}
