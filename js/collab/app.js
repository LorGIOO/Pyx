// The shared session inside Pyx: what the protocol (session.js) needs from
// the app, and what the app needs from the protocol.
//
// HOST — the person whose machine holds the project. Their Pyx shares the
//   folder of the document in front of them (only the editable text files,
//   and only those a guest opens travel), runs every Python cell, compiles
//   for everybody (LaTeX locked down, see latex-guard.js / latex.rs) and
//   saves what the guests write into the real files.
// GUEST — edits the host's files in tabs that have no file of their own,
//   sees the host's PDF (only the changed parts travel), the cells' results
//   and the compile status. Nothing of the document runs on a guest's machine:
//   the kernel and the engine are refused there while the session lasts.

import * as Y from 'yjs';
import { createRoot, createEffect, on } from 'solid-js';
import { state, activeDoc } from '../core/state.js';
import { HostSession, GuestSession } from './session.js';
import { collabHooks } from './hooks.js';
import {
  bindDoc, unbindDoc, unbindAll, isBound, boundPath, docIdOfPath, ydocOf, LOCAL,
} from './ybridge.js';
import { allowedChange, deniedMessage, fileKind, normPerms } from './permissions.js';
import { setMembers, setPresence as storePresence, clearPresence, person } from './presence-store.js';
import { collab, notify, savePrefs } from '../solid/stores/collabStore.js';
import {
  newDocument, openPath, saveDocument, switchTo,
} from '../solid/stores/docStore.js';
import { getDocContent, getDocText, broadcastCellRefresh } from '../editor/setup.js';
import { parseCells, parseCellsText, codeHashMap } from '../editor/cell-parse.js';
import { serializeDoc, hydrateDoc } from '../editor/cell-outputs.js';
import {
  readDir, readPdfFile, readSources, invoke, isTauri, setInvokeGuard,
} from '../core/platform.js';
import { baseName, dirOf, joinPath, relativeTo, samePath, normalizePath } from '../core/paths.js';
import { utf8, fromUtf8 } from './bytes.js';
import { startPresence, stopPresence } from './presence-tracker.js';
import { startPointers, stopPointers } from './pointer-layer.js';

export const DEFAULT_RELAY = 'wss://relay.pyx.example';

let host = null;   // HostSession
let guest = null;  // GuestSession
let disposeEffects = null;

/* ======================================================================
 * shared helpers
 * ==================================================================== */

const docById = (id) => state.documents.find((d) => d.id === id) || null;

function resetUi() {
  collab.role = null;
  collab.phase = 'idle';
  collab.conn = '';
  collab.invite = '';
  collab.code = '';
  collab.me = null;
  collab.members = [];
  collab.joins = [];
  collab.files = [];
  collab.main = null;
  collab.follow = null;
}

function clearHooks() {
  for (const k of Object.keys(collabHooks)) collabHooks[k] = null;
  setInvokeGuard(null);
}

/* ======================================================================
 * HOST
 * ==================================================================== */

let root = null;            // project folder (null: an unsaved single document)
let mainRel = null;
let mainDocId = null;
let fileSet = new Set();
const hostY = new Map();    // rel → Y.Doc (lives as long as the session)
const saveTimers = new Map();
const lastOuts = new Map();
let filesTimer = 0;
let lastEdit = null;        // rel of the shared file edited last (what a compile builds)

const SKIP_DIRS = /^(\.|node_modules$|__pycache__$|\.git$|venv$|\.venv$|env$)/;
const EDITABLE = /\.(pltx|tex|bib|sty|cls|bst|txt|md|py)$/i;

/* ---------- the shared folder («carpeta madre») ----------
 *
 * A report often keeps its preamble in one folder and its chapters, figures
 * and bibliography in sibling folders (`\input{../capitulos/cap1}`). Sharing
 * only the root document's folder left those out: guests could not open them
 * and the compile refused the `../`. The shared folder is therefore the
 * common ancestor of the root document and everything it pulls in — found by
 * reading the \input tree — and the host can pick another one. */

const REF_RE = /\\(?:input|include|subfile|includegraphics|includepdf|includesvg|lstinputlisting|verbatiminput|inputminted|bibliography|addbibresource|pyfile|pynotebook)\*?\s*(?:\[[^\]]*\]\s*)*(?:\{[^{}]*\}\s*)?\{([^{}\\]+)\}/g;
const INPUT_RE = /\\(?:input|include|subfile)\s*\{([^{}\\]+)\}/g;

const segs = (p) => normalizePath(p).replace(/\\/g, '/').replace(/\/+$/, '').split('/');

function commonAncestor(paths) {
  let common = null;
  for (const p of paths) {
    const s = segs(p);
    if (!common) { common = s; continue; }
    let i = 0;
    while (i < common.length && i < s.length && common[i].toLowerCase() === s[i].toLowerCase()) i++;
    common = common.slice(0, i);
  }
  return common ? common.join('/') || '/' : null;
}

/** The folder a session should share for `doc` (its project's common
 *  ancestor), or null for a document that has no file yet. */
export async function detectShareRoot(doc) {
  if (!doc || doc.kind || !doc.path) return null;
  let rootDir = dirOf(doc.path);
  try {
    const comp = await import('../compile/compiler.js');
    rootDir = (await comp.activeRootDir()) || rootDir;
  } catch (_) { /* keep the document's folder */ }
  const dirs = [rootDir, dirOf(doc.path)];
  const seen = new Set();
  let queue = [{ path: doc.path, text: getDocContent(doc.id) }];
  for (let round = 0; round < 6 && queue.length && seen.size < 150; round++) {
    const next = [];
    for (const f of queue) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      const text = String(f.text || '').replace(/(^|[^\\])%.*$/gm, '$1');
      for (const m of text.matchAll(REF_RE)) {
        for (const name of m[1].split(',')) {
          const n = name.trim();
          if (!n || /^(~|\\\\|\|)/.test(n)) continue;
          const abs = /^([A-Za-z]:[\\/]|\/)/.test(n) ? n : joinPath(rootDir, n);
          dirs.push(dirOf(normalizePath(abs)));
        }
      }
      for (const m of text.matchAll(INPUT_RE)) {
        const n = m[1].trim();
        const abs = normalizePath(/^([A-Za-z]:[\\/]|\/)/.test(n) ? n : joinPath(rootDir, n));
        for (const c of /\.[a-z0-9]+$/i.test(abs) ? [abs] : [abs + '.tex', abs + '.pltx']) next.push(c);
      }
    }
    const fresh = next.filter((p) => !seen.has(p));
    if (!fresh.length) break;
    let texts = [];
    try { texts = await readSources(fresh); } catch (_) { texts = []; }
    queue = fresh.map((p, i) => ({ path: p, text: texts[i] })).filter((f) => typeof f.text === 'string');
  }
  const anc = commonAncestor(dirs) || rootDir;
  // Never climb, on its own, to the user's home folder or above it (that
  // would offer every document they have), to a drive or the file-system
  // root, or more than four levels above the root document. The host sees
  // the folder before sharing and can choose another.
  let home = null;
  try { home = isTauri() ? await (await import('@tauri-apps/api/path')).homeDir() : null; } catch (_) { home = null; }
  const depth = segs(anc).filter(Boolean).length;
  const up = segs(rootDir).length - segs(anc).length;
  if (depth < 2 || up > 4 || (home && relativeTo(anc, home) != null)) return rootDir;
  return anc;
}

async function walkProject(dir) {
  const out = [];
  const queue = [[dir, 0]];
  while (queue.length && out.length < 4000) {
    const [d, depth] = queue.shift();
    let items;
    try { items = await readDir(d); } catch (_) { continue; }
    for (const it of items) {
      if (it.is_dir) {
        if (depth < 8 && !SKIP_DIRS.test(it.name)) queue.push([it.path, depth + 1]);
      } else if (EDITABLE.test(it.name) && !/\.build\.tex$/i.test(it.name)) {
        const rel = relativeTo(dir, it.path);
        if (rel) out.push({ path: rel });
      }
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function relOfDoc(doc) {
  if (!doc || doc.kind) return null;
  if (!root) return doc.id === mainDocId ? mainRel : null;
  if (!doc.path) return null;
  const rel = relativeTo(root, doc.path);
  return rel && fileSet.has(rel) ? rel : null;
}

function absOf(rel) {
  return joinPath(root, rel.split('/').join(root.includes('\\') && !root.includes('/') ? '\\' : '/'));
}

function docOfRel(rel) {
  if (!root) return mainDocId != null && rel === mainRel ? docById(mainDocId) : null;
  return state.documents.find((d) => !d.kind && d.path && relativeTo(root, d.path) === rel) || null;
}

async function refreshFiles(announce = true) {
  if (!root) return;
  const list = await walkProject(root);
  const sig = list.map((f) => f.path).join('\n');
  if (sig === [...fileSet].join('\n')) return;
  fileSet = new Set(list.map((f) => f.path));
  collab.files = list;
  if (announce && host) host.announceFiles();
}

/** Ask the session for a file's shared copy (binds the host's tab to it). */
async function hostOpenDoc(rel) {
  if (!fileSet.has(rel)) throw new Error('Ese archivo no forma parte del proyecto compartido.');
  let doc = docOfRel(rel);
  if (!doc) {
    if (!root) throw new Error('El documento ya no está abierto.');
    await openPath(absOf(rel), { background: true });
    doc = docOfRel(rel);
    if (!doc) throw new Error('No se pudo abrir el archivo en el equipo del anfitrión.');
  }
  let ydoc = hostY.get(rel);
  if (!ydoc) {
    ydoc = new Y.Doc();
    hostY.set(rel, ydoc);
    bindDoc(doc.id, ydoc, rel, { from: 'cm' });
    // What the guests write is saved into the real file, quietly. And the
    // file written in last is the one the next compile builds (its root).
    ydoc.on('update', (_u, origin) => {
      lastEdit = rel;
      if (origin !== LOCAL) scheduleSave(rel);
    });
  } else if (!isBound(doc.id)) {
    bindDoc(doc.id, ydoc, rel, { from: 'y' });
  }
  return ydoc;
}

function scheduleSave(rel) {
  let t = saveTimers.get(rel);
  const now = Date.now();
  if (!t) { t = { first: now, timer: 0 }; saveTimers.set(rel, t); }
  clearTimeout(t.timer);
  const wait = Math.max(0, Math.min(3000, 15000 - (now - t.first)));
  t.timer = setTimeout(() => { saveTimers.delete(rel); saveShared(rel); }, wait);
}

async function saveShared(rel) {
  let doc = docOfRel(rel);
  // The host closed that tab while someone kept writing: open it again in
  // the background so the file on disk gets the changes.
  if ((!doc || !isBound(doc.id)) && root && host) {
    try { await hostOpenDoc(rel); } catch (_) { return; }
    doc = docOfRel(rel);
    if (doc) doc.modified = true;
  }
  if (doc && doc.path && doc.modified) {
    await saveDocument(doc, { compile: false, trim: false, interactive: false }).catch(() => {});
  }
}

let publishing = Promise.resolve();
let pendingPdf = null;
function publishPdf(pdfPath, rootPath) {
  if (!host) return;
  if (root && rootPath && relativeTo(root, rootPath) == null) return; // another project
  pendingPdf = pdfPath;
  publishing = publishing.then(async () => {
    const p = pendingPdf;
    if (!p || !host) return;
    pendingPdf = null;
    try {
      const bytes = await readPdfFile(p);
      await host.publish('pdf', 'main', bytes, { name: baseName(p) });
    } catch (e) { console.warn('[Pyx] no se pudo enviar el PDF:', e); }
  });
}

function publishOutputs() {
  if (!host) return;
  for (const [rel] of hostY) {
    const doc = docOfRel(rel);
    if (!doc) continue;
    let json = null;
    try { json = serializeDoc(doc.id, codeHashMap(parseCellsText(getDocContent(doc.id)))); } catch (_) { json = null; }
    if (!json || json === lastOuts.get(rel)) continue;
    lastOuts.set(rel, json);
    host.publish('outs', rel, utf8(json)).catch(() => {});
  }
}

export async function startHosting({ relay, name, perms, folder = null }) {
  if (host || guest) throw new Error('Ya hay una sesión en marcha.');
  const doc = activeDoc();
  if (!doc || doc.kind) throw new Error('Abre el documento que quieres compartir.');
  if (!/^wss?:\/\//i.test(relay || '')) throw new Error('Escribe la dirección del servidor (wss://…).');
  collab.role = 'host';
  collab.phase = 'starting';
  collab.error = '';
  collab.name = name; collab.relay = relay; collab.defaultPerms = normPerms(perms);
  savePrefs();

  root = doc.path ? (folder || await detectShareRoot(doc) || dirOf(doc.path)) : null;
  if (root && relativeTo(root, doc.path) == null) {
    resetUi();
    throw new Error('La carpeta compartida tiene que contener el documento que compartes.');
  }
  collab.folder = root;
  mainDocId = doc.id;
  if (root) {
    mainRel = relativeTo(root, doc.path);
    await refreshFiles(false);
    if (!fileSet.has(mainRel)) { fileSet.add(mainRel); collab.files = [...collab.files, { path: mainRel }]; }
  } else {
    mainRel = doc.fileName || 'documento.pltx';
    fileSet = new Set([mainRel]);
    collab.files = [{ path: mainRel }];
  }
  collab.main = mainRel;

  host = new HostSession({
    relay,
    name,
    adapter: {
      openDoc: hostOpenDoc,
      fileName: (rel) => rel,
      // The editor's immutable text and its (memoized) cells: the fast path
      // of the permission check on big documents (permissions.js).
      textOf: (rel) => { const d = docOfRel(rel); return d && isBound(d.id) ? getDocText(d.id) : null; },
      cellsOf: (text) => parseCells({ doc: text }),
      files: () => collab.files.map((f) => ({ path: f.path })),
      // The request card (title bar / dialog) asks the question; no toast.
      joinRequest: (r) => { collab.joins = [...collab.joins, r]; },
      onMembers: (list) => { collab.members = list; setMembers(list, 'host'); },
      onPresence: (mid, s) => storePresence(mid, s),
      onStatus: (s) => { collab.conn = s; },
      compileRequest: (m) => {
        // Compile what THAT person is looking at (its root document).
        const where = person(m.mid);
        if (where && where.state && where.state.f && fileSet.has(where.state.f)) lastEdit = where.state.f;
        const target = collabHooks.compileTarget && collabHooks.compileTarget();
        if (!target || !target.path) {
          notify(`${m.name} quiere compilar: guarda el documento en una carpeta para poder compilar para todos.`, 'warn', 7000);
          return;
        }
        import('../compile/compiler.js').then((c) => c.compileActive(false, { force: true })).catch(() => {});
      },
      rpc: hostRpc,
      denied: (m, path, why) => {
        if (why === 'python' || why === 'latex') notify(`Se deshizo un cambio de ${m.name} en ${path}: ${why === 'python' ? 'no tiene permiso para Python' : 'solo tiene permiso para Python'}.`, 'warn');
      },
    },
  });
  host.main = mainRel;

  // Hooks the app calls.
  collabHooks.shared = (docId) => isBound(docId);
  collabHooks.compileTarget = () => {
    const last = lastEdit && docOfRel(lastEdit);
    if (last) return last;
    const a = activeDoc();
    if (a && relOfDoc(a)) return a;
    return docOfRel(mainRel);
  };
  collabHooks.pdf = (pdfPath, rootPath) => publishPdf(pdfPath, rootPath);
  collabHooks.compileDone = () => publishOutputs();
  collabHooks.restricted = () => root || true;
  collabHooks.lockMode = (paranoid) => (isTauri()
    ? invoke('collab_restrict', { on: true, paranoid }).catch(() => {})
    : Promise.resolve());
  collabHooks.closed = (d) => { if (isBound(d.id)) unbindDoc(d.id); };
  if (isTauri()) await invoke('collab_restrict', { on: true }).catch(() => {});

  try {
    collab.invite = await host.start();
    await host.doc(mainRel); // the host's own edits and caret are shared from now
  } catch (e) {
    await endSession();
    throw e;
  }
  collab.phase = 'in';
  collab.me = { mid: 'host', name, color: '#e8590c' };
  host.announceMembers();

  // The compile status, mirrored on every guest's status bar.
  disposeEffects = createRoot((dispose) => {
    let timer = 0;
    createEffect(() => {
      const s = {
        compiling: state.compiling, phase: state.compilePhase, ok: state.lastCompileOk,
        reason: state.compileReason, ms: state.compileMs, pending: state.livePending,
      };
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!host) return;
        // The log only once a compile is over (it can be long).
        if (!s.compiling) s.log = String(state.lastLog || '').slice(-80_000);
        host.compileStatus(s);
      }, 120);
    });
    return dispose;
  });
  filesTimer = setInterval(() => { refreshFiles(true).catch(() => {}); }, 15000);
  startPresence({ role: 'host', publish: (s) => host && host.myPresence(s), ensureShared: hostEnsureShared });
  startPointers();
  // Whatever is on screen now is shared at once: compile it for the guests.
  if (doc.path) import('../compile/compiler.js').then((m) => m.compileActive(false)).catch(() => {});
}

/** The host moved to another file of the project: share it so their caret
 *  and pointer can be shown. */
function hostEnsureShared(doc) {
  if (!host || !doc) return;
  const rel = relOfDoc(doc);
  if (rel && !isBound(doc.id)) host.doc(rel).catch(() => {});
}

async function hostRpc(_member, method, a) {
  if (method === 'synctexEdit') {
    if (!state.lastPdfPath) throw new Error('Aún no hay PDF');
    const { synctexResolve } = await import('../pdf/preview.js');
    const hit = await synctexResolve(state.lastPdfPath, +a.page || 1, +a.x || 0, +a.y || 0);
    let line = hit.line;
    if (hit.wasBuild) line = (await import('../editor/commands.js')).buildLineToSource(hit.path, line);
    const rel = root ? relativeTo(root, hit.path) : mainRel;
    if (!rel || !fileSet.has(rel)) throw new Error('Fuera del proyecto');
    return { path: rel, line, column: hit.column };
  }
  if (method === 'synctexView') {
    if (!state.lastPdfPath) throw new Error('Aún no hay PDF');
    const rel = String(a.path || '');
    if (!fileSet.has(rel) || !root) throw new Error('Fuera del proyecto');
    const { synctexLocate } = await import('../editor/commands.js');
    return synctexLocate(absOf(rel), Math.max(1, +a.line || 1));
  }
  throw new Error('Petición desconocida');
}

export async function approveJoin(id, perms) {
  collab.joins = collab.joins.filter((j) => j.id !== id);
  if (host) await host.approve(id, normPerms(perms));
}

export async function rejectJoin(id) {
  collab.joins = collab.joins.filter((j) => j.id !== id);
  if (host) await host.reject(id);
}

export function setMemberPerms(mid, perms) { if (host) host.setPerms(mid, normPerms(perms)); }
export async function kickMember(mid) { if (host) await host.kick(mid); }

/* ======================================================================
 * GUEST
 * ==================================================================== */

const outsCache = new Map(); // rel → outputs JSON from the host

function guestFilter(docId, tr) {
  const doc = docById(docId);
  if (!doc || !doc.remote || !guest) return true;
  const p = collab.perms;
  if (p.python && p.latex) return true;
  const kind = fileKind(doc.remote.path);
  let ok;
  let why = 'read';
  if (!p.python && !p.latex) ok = false;
  else if (kind === 'python') { ok = p.python; why = 'python'; }
  else if (kind === 'latex') { ok = p.latex; why = 'latex'; }
  else {
    // A window around the change, widened to whole cells: the same rule the
    // host applies to the whole text, without stringifying the whole text on
    // every key press.
    const a = tr.startState.doc, b = tr.state.doc;
    const widen = (doc, cells, from, to) => {
      let l1 = doc.lineAt(from).number - 1, l2 = doc.lineAt(to).number + 1;
      for (const c of cells) {
        if (c.endLine >= l1 && c.headerLine <= l2) { l1 = Math.min(l1, c.headerLine); l2 = Math.max(l2, c.endLine); }
      }
      l1 = Math.max(1, l1); l2 = Math.min(doc.lines, l2);
      return [doc.line(l1).from, doc.line(l2).to];
    };
    let from = Infinity, to = -Infinity;
    tr.changes.iterChangedRanges((fA, tA) => { from = Math.min(from, fA); to = Math.max(to, tA); });
    // Old window (whole lines, whole cells) → new text, widened there too
    // (a cell the edit CREATES), → back to the old text: both windows then
    // cover the same stretch, and everything outside them is identical.
    let [aFrom, aTo] = widen(a, parseCells(tr.startState), from, to);
    const [bFrom, bTo] = widen(b, parseCells(tr.state), tr.changes.mapPos(aFrom, -1), tr.changes.mapPos(aTo, 1));
    const inv = tr.changes.invert(a);
    aFrom = Math.min(aFrom, a.lineAt(inv.mapPos(bFrom, -1)).from);
    aTo = Math.max(aTo, a.lineAt(inv.mapPos(bTo, 1)).to);
    const before = a.sliceString(aFrom, aTo);
    const after = b.sliceString(Math.min(bFrom, tr.changes.mapPos(aFrom, -1)), Math.max(bTo, tr.changes.mapPos(aTo, 1)));
    const v = allowedChange(before, after, doc.remote.path, p);
    ok = v.ok;
    why = v.why || why;
  }
  if (!ok) notify(deniedMessage(why), 'warn');
  return ok;
}

function onGuestDocReady(rel, ydoc, name) {
  const existing = docIdOfPath(rel);
  if (existing != null && docById(existing)) return;
  const id = newDocument(ydoc.getText('t').toString(), baseName(name || rel), null, null, { remote: { path: rel } });
  bindDoc(id, ydoc, rel, { from: 'y' });
  const outs = outsCache.get(rel);
  if (outs) { hydrateDoc(id, outs, codeHashMap(parseCellsText(getDocContent(id)))); broadcastCellRefresh(); }
}

export async function openSharedFile(rel) {
  if (host) {
    if (!root) return;
    await openPath(absOf(rel));
    return;
  }
  if (!guest) return;
  const id = docIdOfPath(rel);
  if (id != null) {
    const i = state.documents.findIndex((d) => d.id === id);
    if (i >= 0) { switchTo(i); return; }
  }
  try {
    await guest.openDoc(rel);
    const nid = docIdOfPath(rel);
    const i = state.documents.findIndex((d) => d.id === nid);
    if (i >= 0) switchTo(i);
  } catch (e) {
    notify(`No se pudo abrir ${rel}: ${String((e && e.message) || e)}`, 'error');
  }
}

function guestEnded(why) {
  const msg = {
    kicked: 'El anfitrión te ha sacado de la sesión.',
    end: 'El anfitrión ha terminado la sesión.',
    'host-gone': 'El anfitrión lleva demasiado tiempo desconectado: la sesión ha terminado.',
    rejected: 'El anfitrión no ha aceptado tu petición.',
    'no-room': 'Esa sesión ya no existe (o el código no es correcto).',
    version: 'Tu Pyx y el del anfitrión no hablan la misma versión del protocolo. Actualizad los dos.',
    full: 'La sesión está llena.',
    left: 'Has salido de la sesión.',
  }[why] || 'La sesión ha terminado.';
  // The text stays: each tab becomes a normal unsaved document the guest can
  // keep («Guardar como»).
  for (const d of state.documents) {
    if (d.remote) { unbindDoc(d.id); d.remote = null; d.modified = true; }
  }
  teardown();
  collab.phase = 'ended';
  collab.error = why === 'left' ? '' : msg;
  notify(msg, why === 'left' ? 'info' : 'warn', 8000);
}

export async function joinSession({ invite, name }) {
  if (host || guest) throw new Error('Ya hay una sesión en marcha.');
  collab.role = 'guest';
  collab.phase = 'starting';
  collab.error = '';
  collab.code = '';
  collab.name = name;
  savePrefs();
  guest = new GuestSession({
    invite,
    name,
    adapter: {
      onCode: (c) => { collab.code = c; collab.phase = collab.phase === 'in' ? 'in' : 'waiting'; },
      onAdmitted: (info) => {
        collab.phase = 'in';
        collab.me = info.me;
        collab.perms = info.perms;
        collab.files = info.files || [];
        collab.main = info.main;
        collab.members = info.members || [];
        setMembers(collab.members, info.me.mid);
        if (info.first) {
          notify('Estás dentro. Lo que escribas lo ven los demás al instante.', 'info');
          if (info.main) openSharedFile(info.main);
          collab.dialog = false;
        }
      },
      onEnd: (why) => guestEnded(why),
      onStatus: (s) => {
        collab.conn = s;
        if (s === 'open' && collab.phase === 'starting') collab.phase = 'waiting';
      },
      onFiles: (files, main) => { collab.files = files; collab.main = main; },
      onMembers: (list) => { collab.members = list; setMembers(list); },
      onPerms: (p) => {
        collab.perms = p;
        notify(`El anfitrión ha cambiado tus permisos.`, 'info');
      },
      onPresence: (mid, s) => storePresence(mid, s),
      onDocReady: onGuestDocReady,
      onNoDoc: (rel, why) => notify(`No se pudo abrir ${rel}: ${why}`, 'error'),
      onDenied: (_path, why) => notify(deniedMessage(why), 'warn'),
      onBlob: (kind, key, bytes, meta) => {
        if (kind === 'pdf') {
          import('../pdf/preview.js').then((m) => m.loadPdfBytes(bytes, meta.name || 'documento.pdf')).catch(() => {});
          state.pdfForeign = false;
        } else if (kind === 'outs') {
          const json = fromUtf8(bytes);
          outsCache.set(key, json);
          const id = docIdOfPath(key);
          if (id != null) { hydrateDoc(id, json, codeHashMap(parseCellsText(getDocContent(id)))); broadcastCellRefresh(); }
        }
      },
      onCompileStatus: (s) => {
        state.compiling = !!s.compiling;
        state.compilePhase = s.compiling ? (s.phase || 'latex') : null;
        state.livePending = !!s.pending;
        if (!s.compiling) {
          if (s.ok !== undefined) state.lastCompileOk = s.ok;
          if (typeof s.reason === 'string') state.compileReason = s.reason;
          if (typeof s.ms === 'number') state.compileMs = s.ms;
          if (typeof s.log === 'string') state.lastLog = s.log;
        }
      },
    },
  });

  collabHooks.modified = (docId) => { const d = docById(docId); return !(d && d.remote); };
  collabHooks.filter = guestFilter;
  collabHooks.compile = () => {
    if (guest && collab.phase === 'in') guest.requestCompile();
    return true;
  };
  collabHooks.save = (_doc, { compile }) => {
    notify('Lo que escribes se guarda solo en el equipo del anfitrión.', 'info', 3000);
    if (compile && guest) guest.requestCompile();
  };
  collabHooks.closed = (d) => {
    if (!d.remote || !guest) return;
    unbindDoc(d.id);
    guest.closeDoc(d.remote.path);
  };
  collabHooks.shared = (docId) => isBound(docId);
  collabHooks.synctexEdit = async (page, x, y, word) => {
    const r = await guest.rpc('synctexEdit', { page, x, y });
    await openSharedFile(r.path);
    const cmds = await import('../editor/commands.js');
    cmds.gotoLineCol(r.line, r.column, word);
  };
  collabHooks.synctexView = (doc, line) => guest.rpc('synctexView', { path: doc.remote.path, line });
  const REFUSE = new Set(['kernel_start', 'kernel_exec', 'kernel_reset', 'compile_latex', 'install_packages', 'chktex_lint']);
  setInvokeGuard((cmd) => (REFUSE.has(cmd) && guest
    ? 'Durante una sesión compartida, el Python y la compilación se ejecutan en el equipo del anfitrión.'
    : null));

  try {
    await guest.start();
  } catch (e) {
    teardown();
    resetUi();
    throw e;
  }
  startPresence({ role: 'guest', publish: (s) => guest && guest.setPresence(s), ensureShared: () => {} });
  startPointers();
}

/* ======================================================================
 * both
 * ==================================================================== */

function teardown() {
  stopPresence();
  stopPointers();
  clearPresence();
  unbindAll();
  clearHooks();
  if (disposeEffects) { disposeEffects(); disposeEffects = null; }
  clearInterval(filesTimer);
  for (const t of saveTimers.values()) clearTimeout(t.timer);
  saveTimers.clear();
  hostY.clear();
  lastOuts.clear();
  outsCache.clear();
  if (isTauri() && host) invoke('collab_restrict', { on: false }).catch(() => {});
  host = null;
  guest = null;
  root = null; mainRel = null; mainDocId = null; fileSet = new Set(); lastEdit = null;
  collab.folder = null;
}

/** Leave (guest) or end the session for everyone (host). */
export async function endSession() {
  if (host) {
    const h = host;
    // Pending guest edits go to disk before the session lets go of them.
    for (const [rel, t] of saveTimers) { clearTimeout(t.timer); await saveShared(rel); }
    await h.end().catch(() => {});
    teardown();
    resetUi();
    notify('Has terminado la sesión compartida.', 'info');
    return;
  }
  if (guest) {
    await guest.leave().catch(() => {});
    if (guest) guestEnded('left');
    resetUi();
  }
}

/** For the side panel / follow mode. */
export function sessionDocText(rel) {
  const id = docIdOfPath(rel);
  return id != null ? getDocText(id) : null;
}

export { ydocOf, boundPath };

/** For the tests and the developer console only: the live sessions. */
export const sessionInternals = () => ({ host, guest });
