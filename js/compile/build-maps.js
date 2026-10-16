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
//
// THEY ARE ALSO WRITTEN TO DISK (`pyx-mapas.json`, in the working directory,
// next to the PDF). They used to exist only in memory, from the moment a
// compile ran: open a document, its saved PDF appears — and Ctrl+click in it
// opened the internal `.build.tex` copy, while Ctrl+click in the code found
// nothing at all, until the first compile of the session. On disk, they are
// there whenever the PDF is (and travel inside the .pltx with it).

import { readTextFile, writeTextFile } from '../core/platform.js';

export const MAP_FILE = 'pyx-mapas.json';

/** build basename (lowercase) -> srcLines[] */
let maps = Object.create(null);
/** build basename (lowercase) -> real source path */
let buildMap = Object.create(null);
/** build path relative to the working directory (lowercase, '/') -> real source */
let relMap = Object.create(null);
/** basenames (lowercase) of every file in the last compiled project */
let knownFiles = new Set();
/** basename of the root build file */
let rootFile = null;
/** the project's folder, and its working directory (outside the project) */
let projectDir = null;
let workDir = null;

const norm = (s) => String(s || '')
  .normalize('NFC')
  .replace(/\\/g, '/')
  .replace(/\/\.(?=\/)/g, '')
  .replace(/\/+$/, '');
const lower = (s) => norm(s).toLowerCase();

export function setBuildMaps({ lineMaps, buildToReal, known, root, project, work, files }) {
  maps = lineMaps || Object.create(null);
  buildMap = buildToReal || Object.create(null);
  knownFiles = known || new Set();
  rootFile = root || null;
  projectDir = project || null;
  workDir = work || null;
  relMap = Object.create(null);
  for (const [rel, real] of Object.entries(files || {})) relMap[lower(rel)] = real;
}

export const projectRoot = () => projectDir;
export const workingDir = () => workDir;

/* ---- on disk ---- */

// A line map is almost always "the same line, shifted": store only where the
// shift changes. [length, [buildLine, srcLine], …]
function encodeMap(arr) {
  const out = [arr.length];
  for (let i = 0; i < arr.length; i++) {
    if (i === 0 || arr[i] !== arr[i - 1] + 1) out.push([i + 1, arr[i]]);
  }
  return out;
}
function decodeMap(enc) {
  if (!Array.isArray(enc) || !enc.length) return null;
  const n = enc[0];
  const arr = new Array(n);
  let k = 1;
  for (let i = 0; i < n; i++) {
    while (k + 1 < enc.length && enc[k + 1][0] <= i + 1) k++;
    const [b, s] = enc[k] || [1, 1];
    arr[i] = s + (i + 1 - b);
  }
  return arr;
}

export async function persistBuildMaps(data) {
  if (!data || !data.work) return;
  const lineMaps = {};
  for (const [k, v] of Object.entries(data.lineMaps || {})) if (Array.isArray(v)) lineMaps[k] = encodeMap(v);
  const json = JSON.stringify({
    v: 1,
    project: data.project,
    work: data.work,
    root: data.root,
    files: data.files || {},
    buildToReal: data.buildToReal || {},
    lineMaps,
  });
  await writeTextFile(`${norm(data.work)}/${MAP_FILE}`, json);
}

/**
 * Make sure the maps of the build that lives in `work` are the ones loaded —
 * from memory if this session compiled it, from its `pyx-mapas.json`
 * otherwise. Returns false when there is nothing to load (never compiled).
 */
export async function ensureBuildMaps(work) {
  if (!work) return false;
  if (workDir && lower(workDir) === lower(work)) return true;
  let data;
  try {
    data = JSON.parse(await readTextFile(`${norm(work)}/${MAP_FILE}`));
  } catch (_) {
    return false;
  }
  if (!data || data.v !== 1) return false;
  const lineMaps = Object.create(null);
  for (const [k, v] of Object.entries(data.lineMaps || {})) {
    const m = decodeMap(v);
    if (m) lineMaps[k] = m;
  }
  const known = new Set();
  for (const [k, v] of Object.entries(data.buildToReal || {})) {
    known.add(k);
    known.add(String(v).split(/[\\/]/).pop().toLowerCase());
  }
  setBuildMaps({
    lineMaps,
    buildToReal: data.buildToReal,
    known,
    root: data.root,
    project: data.project,
    // the folder it was found in, which is where the engine wrote it
    work,
    files: data.files,
  });
  return true;
}

/* ---- translating paths ---- */

/** The real source file (.pltx/.tex in the project) of a path the ENGINE
 *  reported — a `.build.tex` copy in the working directory. null when it is
 *  not one of ours. Never returns a `.build.tex`. */
export function sourceOfBuild(enginePath) {
  if (!enginePath) return null;
  const p = lower(enginePath);
  if (workDir) {
    const w = lower(workDir);
    if (p.startsWith(w + '/')) {
      const hit = relMap[p.slice(w.length + 1)];
      if (hit) return hit;
    }
  }
  const base = p.split('/').pop();
  return buildMap[base] || null;
}

/** Back-compat shape used by older callers: { dir, stem } of the source. */
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
  if (!workDir || !realPath) return null;
  const want = lower(realPath);
  for (const [rel, real] of Object.entries(relMap)) {
    if (lower(real) === want) return norm(workDir) + '/' + rel;
  }
  if (!projectDir) return null;
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
  const build = sourceToBuildPath(realPath);
  if (build) {
    const m = maps[build.split('/').pop().toLowerCase()];
    if (m) return m;
  }
  const base = (String(realPath).split(/[\\/]/).pop() || '')
    .replace(/\.(tex|pltx)$/i, '')
    .toLowerCase() + '.build.tex';
  return maps[base] || null;
}
