// Which value a \py{} shows when a name is given more than once.
//
// A document can link several files — \pyfile{datos.py}, then later
// \pynotebook{oleaje.ipynb} — that both define `Hs`. Read top to bottom, the
// \py{Hs} under the first link means the first file's Hs, and the one under
// the second link the second's: the value of the NEAREST file (or cell) above
// the \py{}, exactly as when you read a notebook. Python runs everything in
// one namespace and ends up holding only the LAST Hs, so the compile marks
// each \py{} that needs another one (`\py{Hs #@s1}`), tells the kernel which
// entry gave each name its value there, and has that entry keep a copy of what
// it gave (kernel.py _SCOPES, cell-runner.js captureScope).
//
// Only names defined more than once are affected, and only for a \py{} that
// has a definer above it: a \py{} ABOVE every definer (a summary at the top of
// the report) still shows the final value, as before.

import { analyzePython } from '../editor/py-deps.js';
import { isBuiltin } from '../editor/dep-plan.js';

/** The mark a scoped expression carries (stripped by the kernel). */
export const SCOPE_TAG = /\s?#@s\d+/g;
/** An expression as the user wrote it (the mark removed), for messages. */
export const stripScopeTag = (expr) => String(expr).replace(SCOPE_TAG, '');

/**
 * @param {{key: string, info: {defs: Set<string>}}[]} program  entries in run order
 * @param {{path: string, kind: 'py'|'pyif', start: number, end: number,
 *          text: string, pos: number}[]} occurrences
 *   every \py{} (text = its expression) and top-level \pyif{} (text = its
 *   condition) with `pos` = how many program entries come before it
 * @returns {{ scopes: Object<string, Object<string, string>>,
 *             tags: Map<string, {start: number, end: number, text: string, sid: string, kind: string}[]>,
 *             captures: Map<string, Set<string>> }}
 *   scopes — mark id -> {name: entry key}; tags — per file, the occurrences
 *   to mark; captures — entry key -> names it must keep a copy of.
 */
export function scopeExpressions(program, occurrences) {
  const scopes = {};
  const tags = new Map();
  const captures = new Map();
  const definers = new Map(); // name -> ascending entry indices
  program.forEach((p, i) => {
    for (const d of (p.info && p.info.defs) || []) {
      if (!definers.has(d)) definers.set(d, []);
      definers.get(d).push(i);
    }
  });
  let multi = false;
  for (const v of definers.values()) if (v.length > 1) { multi = true; break; }
  if (!multi) return { scopes, tags, captures };

  const bySig = new Map();
  for (const occ of occurrences) {
    let reads;
    try { reads = analyzePython(String(occ.text)).reads; } catch (_) { continue; }
    const over = {};
    for (const n of reads) {
      if (isBuiltin(n)) continue;
      const idx = definers.get(n);
      if (!idx || idx.length < 2) continue;
      let prev = -1;
      for (const i of idx) { if (i < occ.pos) prev = i; else break; }
      // Nothing above it, or the nearest IS the last: the final value is right.
      if (prev < 0 || prev === idx[idx.length - 1]) continue;
      over[n] = program[prev].key;
    }
    const names = Object.keys(over).sort();
    if (!names.length) continue;
    const sig = names.map((n) => `${n}=${over[n]}`).join('\n');
    let sid = bySig.get(sig);
    if (!sid) {
      sid = `s${bySig.size + 1}`;
      bySig.set(sig, sid);
      scopes[sid] = over;
      for (const n of names) {
        if (!captures.has(over[n])) captures.set(over[n], new Set());
        captures.get(over[n]).add(n);
      }
    }
    if (!tags.has(occ.path)) tags.set(occ.path, []);
    tags.get(occ.path).push({ start: occ.start, end: occ.end, text: occ.text, sid, kind: occ.kind });
  }
  return { scopes, tags, captures };
}

/** `content` with the marks of `list` written into its \py{} and \pyif{}. */
export function applyScopeTags(content, list) {
  let out = content;
  for (const t of [...list].sort((a, b) => b.start - a.start)) {
    if (t.kind === 'py') {
      const was = `\\py{${t.text}}`;
      if (out.slice(t.start, t.end) !== was) continue;
      out = out.slice(0, t.start) + `\\py{${t.text} #@${t.sid}}` + out.slice(t.end);
    } else {
      const was = `\\pyif{${t.text}}`;
      if (!out.startsWith(was, t.start)) continue;
      out = out.slice(0, t.start) + `\\pyif{${t.text} #@${t.sid}}` + out.slice(t.start + was.length);
    }
  }
  return out;
}

/** Where each \py{} / top-level \pyif{} of a file stands among the program
 *  entries: `fileStart` is the entry count when the file began, `events` its
 *  events with `at` (offset) and `end` (entry count after them). */
export function occurrencesOf(path, f, fileStart) {
  const evs = (f.events || []).filter((e) => typeof e.at === 'number' && typeof e.end === 'number');
  const place = (at) => {
    let pos = fileStart;
    for (const e of evs) { if (e.at < at) pos = e.end; else break; }
    return pos;
  };
  const out = [];
  for (const e of f.pyExprs || []) out.push({ path, kind: 'py', start: e.start, end: e.end, text: e.expr, pos: place(e.start) });
  for (const e of f.pyIfs || []) out.push({ path, kind: 'pyif', start: e.start, end: e.end, text: e.cond, pos: place(e.start) });
  return out;
}
