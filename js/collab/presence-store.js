// Who is in the session and where each person is, for the editor overlays
// (carets, mouse pointers) and the side panel. Plain JS (not a Solid store):
// it changes up to ~30 times per second per person, and the overlays read it
// on animation frames — a reactive store would re-render the UI that often.

const people = new Map(); // mid → { mid, name, color, perms, online, host, state, at }
const subs = new Set();     // anything changed (pointers, panel)
const selSubs = new Set();  // a caret/selection or a file changed (editor decorations)
let myMid = null;
let frame = 0;
let selDirty = false;

function notify(sel = true) {
  if (sel) selDirty = true;
  if (frame) return;
  const run = () => {
    frame = 0;
    const s = selDirty;
    selDirty = false;
    for (const f of subs) { try { f(); } catch (e) { console.error(e); } }
    if (s) for (const f of selSubs) { try { f(); } catch (e) { console.error(e); } }
  };
  frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
}

export function onPresenceChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** Only when someone's caret, selection or open file changed — not on every
 *  mouse movement (that would rebuild the editor decorations 30× a second). */
export function onSelectionChange(fn) {
  selSubs.add(fn);
  return () => selSubs.delete(fn);
}

export function setMembers(list, me) {
  myMid = me ?? myMid;
  const seen = new Set();
  for (const m of list || []) {
    seen.add(m.mid);
    const p = people.get(m.mid) || { state: null, at: 0 };
    people.set(m.mid, { ...p, mid: m.mid, name: m.name, color: m.color, perms: m.perms, online: m.online, host: !!m.host });
  }
  for (const k of [...people.keys()]) if (!seen.has(k)) people.delete(k);
  notify();
}

export function setPresence(mid, state) {
  if (mid === myMid) return;
  const p = people.get(mid) || { mid, name: '…', color: '#888', online: true };
  const prev = p.state;
  const selMoved = !prev || !state || prev.f !== state.f
    || String(prev.s) !== String(state.s);
  const now = performance.now();
  people.set(mid, { ...p, state, at: now, selAt: selMoved ? now : (p.selAt || now) });
  notify(selMoved);
}

export function clearPresence() {
  people.clear();
  myMid = null;
  notify();
}

/** Everyone but me who is online. */
export function others() {
  const out = [];
  for (const p of people.values()) if (p.mid !== myMid && p.online !== false) out.push(p);
  return out;
}

export const person = (mid) => people.get(mid) || null;
