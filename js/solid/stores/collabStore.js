// Reactive state of a shared session, for the UI (title bar, dialog, side
// panel, status bar). The fast-changing part — where each person's mouse
// and caret are — lives in collab/presence-store.js instead.
import { createMutable } from 'solid-js/store';

const STORE_KEY = 'pyx.collab';

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return p && typeof p === 'object' ? p : {};
  } catch (_) { return {}; }
}

const prefs = loadPrefs();

export const collab = createMutable({
  role: null,          // null | 'host' | 'guest'
  phase: 'idle',       // idle | starting | waiting | in | ended
  conn: '',            // connecting | open | reconnecting | closed | host-down
  invite: '',          // host: the code to send
  code: '',            // guest: safety code shown while waiting
  me: null,            // { mid, name, color }
  perms: { python: true, latex: true },
  members: [],         // [{ mid, name, color, perms, online, host }]
  joins: [],           // host: requests waiting for a yes/no [{ id, name, code }]
  files: [],           // [{ path }] of the shared project
  main: null,          // path of the main document
  follow: null,        // mid being followed
  notice: '',          // a short message (denied edit, someone joined…)
  noticeKind: 'info',
  noticeAt: 0,
  error: '',
  dialog: false,       // the Compartir / Unirse dialog
  tab: 'share',        // 'share' | 'join'
  // Remembered between sessions (this machine only).
  name: typeof prefs.name === 'string' ? prefs.name : '',
  relay: typeof prefs.relay === 'string' ? prefs.relay : '',
  defaultPerms: prefs.defaultPerms && typeof prefs.defaultPerms === 'object'
    ? { python: !!prefs.defaultPerms.python, latex: prefs.defaultPerms.latex !== false }
    : { python: false, latex: true },
});

export function savePrefs() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      name: collab.name, relay: collab.relay, defaultPerms: collab.defaultPerms,
    }));
  } catch (_) { /* storage unavailable: nothing to remember */ }
}

let noticeTimer = 0;
export function notify(text, kind = 'info', ms = 4500) {
  collab.notice = text;
  collab.noticeKind = kind;
  collab.noticeAt = Date.now();
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { collab.notice = ''; }, ms);
}

export const inSession = () => collab.role != null && collab.phase !== 'ended' && collab.phase !== 'idle';
