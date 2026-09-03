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
/** the project's folder, and its working directory (outside the project) */
let projectDir = null;
let workDir = null;

export function setBuildMaps({ lineMaps, buildToReal, known, root, project, work }) {
  maps = lineMaps || Object.create(null);
  buildMap = buildToReal || Object.create(null);
  knownFiles = known || new Set();
  rootFile = root || null;
  projectDir = project || null;
  workDir = work || null;
}

export const projectRoot = () => projectDir;
export const workingDir = () => workDir;

const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '');

/** A path the engine reported (inside the working directory) mapped back to the
 *  real source file in the project — the inverse of what the compiler wrote.
 *  Returns null when the path is not one of ours. */
export function buildPathToSource(enginePath) {
  if (!workDir || !projectDir || !enginePath) return null;
  const p = norm(enginePath);
  const w = norm(workDir);
  if (!p.toLowerCase().startsWith(w.toLowerCase() + '/')) return null;
  const rel = p.slice(w.length + 1).replace(/\.build\.tex$/i, '');
  return { dir: norm(projectDir), stem: rel };
}

/** The working-directory copy the engine compiles for a real source file. */
export function sourceToBuildPath(realPath) {
  if (!workDir || !projectDir || !realPath) return null;
  const p = norm(realPath);
  const base = norm(projectDir);
  if (!p.toLowerCase().startsWith(base.toLowerCase() + '/')) return null;
  return norm(workDir) + '/' + p.slice(base.length + 1).replace(/\.(tex|pltx)$/i, '') + '.build.tex';
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
