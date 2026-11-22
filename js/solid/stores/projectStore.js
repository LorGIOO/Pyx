// The open project FOLDER (VS Code's "Open Folder").
//
// With a folder open, the explorer shows that folder — the "carpeta madre"
// with every chapter, image and data file — whatever document is active.
// Without one it shows the folder of the active document, as before. The
// choice survives a restart.
import { createSignal } from 'solid-js';
import { state } from '../../core/state.js';
import { openFolderDialog, pathExists } from '../../core/platform.js';

const KEY = 'pyx-project-folder';
const saved = () => { try { return localStorage.getItem(KEY) || null; } catch (_) { return null; } };

export const [projectFolder, setProjectFolderSignal] = createSignal(saved());

function remember(dir) {
  setProjectFolderSignal(dir);
  try { if (dir) localStorage.setItem(KEY, dir); else localStorage.removeItem(KEY); } catch (_) { /* no storage */ }
}

/** Open `dir` (or ask for one) as the project, and show it in the explorer. */
export async function openProjectFolder(dir = null) {
  const folder = dir || await openFolderDialog(projectFolder() || undefined);
  if (!folder) return false;
  remember(folder);
  state.sidePanelTab = 'files';
  return true;
}

export function closeProjectFolder() { remember(null); }

// A folder that no longer exists (renamed, a USB drive that is gone) is
// forgotten instead of showing an empty explorer.
if (projectFolder()) {
  pathExists(projectFolder()).then((ok) => {
    if (!ok) remember(null);
    // Pyx reopens with the project's explorer showing, like VS Code.
    else if (!state.sidePanelTab) state.sidePanelTab = 'files';
  }).catch(() => {});
}
