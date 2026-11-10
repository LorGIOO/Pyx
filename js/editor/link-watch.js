// Linked notebooks and scripts, watched between compiles.
//
// A \pynotebook / \pyfile was only looked at when the document compiled: the
// notebook ran in Jupyter, the script was saved from VS Code, and the PDF kept
// the old numbers until something was typed in Pyx. And the compile that came
// then paid for the whole exchange with Jupyter while the user waited.
//
// Now the files of the LAST compile are polled (one stat call for all of them
// every 1.5 s — no reads, no kernel request while nothing moves):
//   * the linked file itself;
//   * what its last answer depends on (cell-runner.js fetchLink: the
//     snapshot's meta.json, Jupyter's runtime folders, the data files);
//   * and, while a live Jupyter kernel serves it — a kernel changes its values
//     without touching any file — the kernel itself, every few seconds.
// When one moves, the values are asked for right away with the kernel free
// (preloadNotebook: Jupyter copies them to disk and the answer is remembered),
// so the compile finds them ready. Only when they — or the file's code —
// really differ from what the last compile used is a compile scheduled, and
// only with compile-while-typing on.
//
// Polling from here, not a native watcher: no new dependency, nothing to keep
// alive in Rust, and the cost is one `file_stamps` call per tick.
import { fileStamps } from '../core/platform.js';
import { state } from '../core/state.js';
import { loadNotebook, notebookStamp, notebookCodeHash } from './notebooks.js';
import { preloadNotebook, linkWatchInfo } from './cell-runner.js';

const TICK_MS = 1500;
const LIVE_EVERY_MS = 3000;      // a live Jupyter kernel: asked this often
const UNSETTLED_EVERY_MS = 5000; // busy / still starting / not answered yet

let links = [];          // what the last compile linked: [{path, needed, cwd, codeHash, linked, reads}]
const seen = new Map();  // path -> what the last compile (or the last check) saw
// The stamps of the data files read by the linked files whose cells RAN HERE
// (`reads`), as first seen after the compile. Their values are in no answer
// of the kernel — the first one is taken silently, see `check` — so a
// spreadsheet saved from Excel never reached the PDF while the session that
// ran the script was open. Compared with what was FIRST SEEN, not with what
// the cell read: a cell that reads a file and then writes it would otherwise
// ask for a compile after every compile.
let dataSeen = null;
let timer = null;
let ticking = false;
let onChange = null;

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The linked files of the compile that just ended, and what it used of each:
 *  `codeHash` — the code it read; `linked` — it took the values the last
 *  answer described (not its own run of the cells); `reads` — the data files
 *  its cells opened when they ran here. */
export function setLinkWatch(list) {
  links = Array.isArray(list) ? list : [];
  seen.clear();
  dataSeen = null;
}

async function stamps(paths) {
  try {
    const s = await fileStamps(paths);
    return Array.isArray(s) && s.length === paths.length ? s.map((x) => `${x.mtime}:${x.size}`) : null;
  } catch (_) {
    return null;
  }
}

/** One linked file. @returns {Promise<boolean>} a compile would give another result */
async function check(link, now) {
  const info = linkWatchInfo(link.path);
  const paths = [link.path, ...info.watch];
  const st = await stamps(paths);
  if (!st) return false;
  const watchNow = st.slice(1);
  const key = info.watch.join('\n');
  let w = seen.get(link.path);
  if (!w) {
    w = {
      // What the compile READ, not what is there now: a save that landed
      // while it compiled is a change.
      file: notebookStamp(link.path) || st[0],
      codeHash: link.codeHash,
      // Its own run of the cells: whatever the snapshot says first is that
      // same run (taken silently); only values from Jupyter are news.
      sig: link.linked ? info.sig : undefined,
      key,
      watch: (link.linked && info.stamps) || watchNow,
      polled: now,
    };
    seen.set(link.path, w);
  }
  if (w.key !== key) { w.key = key; w.watch = watchNow; } // the answer depends on other files now
  const fileMoved = st[0] !== w.file;
  const moved = !same(watchNow, w.watch);
  let every = Infinity;
  if (info.known && state.liveCompile) every = info.live ? LIVE_EVERY_MS : (info.cached ? Infinity : UNSETTLED_EVERY_MS);
  // Asking is never more than a tenth of the time: a kernel that takes a
  // second to describe its values (large tables) is asked every ten.
  every = Math.max(every, 10 * (w.cost || 0));
  if (!fileMoved && !moved && now - w.polled < every) return false;

  let cells;
  try {
    cells = await loadNotebook(link.path);
  } catch (_) {
    return false; // being written, or gone: looked at again on the next tick
  }
  let res = null;
  if (info.known) {
    const t0 = Date.now();
    res = await preloadNotebook(link.path, cells, link.needed, link.cwd);
    if (!res) return false; // the kernel is busy: nothing is noted, so this is tried again
    w.cost = Date.now() - t0;
  }
  w.file = st[0];
  w.polled = Date.now();
  // Stamps from BEFORE asking — a change that landed meanwhile is seen on the
  // next tick. Except for a live kernel: asking makes it write its values (the
  // very files watched), and it is polled anyway.
  w.watch = (res && res.live && (await stamps(paths)) || st).slice(1);
  let changed = false;
  const hash = notebookCodeHash(cells);
  if (hash !== w.codeHash) { w.codeHash = hash; changed = true; }
  if (res) {
    if (w.sig === undefined && !res.live) w.sig = res.sig;
    else if (res.sig !== w.sig) { w.sig = res.sig; changed = true; }
  }
  return changed;
}

/** Look at every linked file once (the timer's tick; also for tests).
 *  @returns {Promise<boolean>} something changed and `onChange` was called */
export async function checkLinks() {
  if (ticking || !links.length || state.compiling) return false;
  ticking = true;
  try {
    const list = links;
    const now = Date.now();
    const dataPaths = [...new Set(list.flatMap((l) => l.reads || []))];
    const data = dataPaths.length ? await stamps(dataPaths) : null;
    let changed = !!(data && dataSeen && !same(data, dataSeen));
    for (const link of list) {
      if (links !== list || state.compiling) return false; // a compile took over
      // eslint-disable-next-line no-await-in-loop
      if (await check(link, now)) changed = true;
    }
    if (links !== list) return false;
    // Noted only now: a look cut short by a compile says it again next time.
    if (data) dataSeen = data;
    if (changed && onChange) onChange();
    return changed;
  } catch (_) {
    return false; // a watcher never breaks anything
  } finally {
    ticking = false;
  }
}

/** Start watching (once, from the main window). `fn` — called when a compile
 *  would now give a different result. */
export function startLinkWatch(fn) {
  onChange = fn;
  if (timer || typeof setInterval !== 'function') return;
  timer = setInterval(() => {
    // Minimized or in a hidden tab: nobody is looking at the PDF.
    if (typeof document !== 'undefined' && document.hidden) return;
    checkLinks();
  }, TICK_MS);
}

export function stopLinkWatch() {
  clearInterval(timer);
  timer = null;
}
