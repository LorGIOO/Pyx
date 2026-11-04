// Pyx updates itself from its own GitHub releases (src-tauri/src/update.rs):
// a check a few seconds after start-up, and — on Windows — download, SHA-256
// check, install and reopen, from the status bar. Elsewhere the release page
// opens (the .dmg / .deb / .AppImage are installed the usual way).
import { state } from './state.js';
import { invoke, isTauri, openExternal, messageDialog, askDialog } from './platform.js';
import { t } from './i18n.js';

/** Ask GitHub whether a newer Pyx exists (silent when offline). */
export async function checkForUpdate() {
  if (!isTauri()) return null;
  try {
    const info = await invoke('update_check');
    state.update = info && info.newer ? info : null;
    return info;
  } catch (_) {
    return null; // no connection: the next launch asks again
  }
}

/** Install the update checkForUpdate found. The installer closes Pyx, so a
 *  document with unsaved changes stops it: nothing typed may be lost. */
export async function installUpdate() {
  const u = state.update;
  if (!u || state.updateBusy) return;
  if (!u.asset) {
    openExternal(u.page);
    return;
  }
  const unsaved = state.documents.filter((d) => d.modified).map((d) => d.fileName || d.path);
  if (unsaved.length) {
    await messageDialog(t(
      `Guarda antes los cambios de: ${unsaved.join(', ')}.\nLa actualización cierra Pyx para instalar la nueva versión.`,
      `Save your changes first: ${unsaved.join(', ')}.\nUpdating closes Pyx to install the new version.`,
    ));
    return;
  }
  if (!(await askDialog(t(
    `Pyx ${u.latest} está disponible (tienes la ${u.current}).\n\nSe descargará, se comprobará y se instalará; Pyx se cerrará y volverá a abrirse solo. ¿Actualizar ahora?`,
    `Pyx ${u.latest} is available (you have ${u.current}).\n\nIt will be downloaded, verified and installed; Pyx closes and reopens by itself. Update now?`,
  ), { kind: 'info' }))) return;
  state.updateBusy = true;
  try {
    await invoke('update_install', { asset: u.asset });
  } catch (e) {
    state.updateBusy = false;
    await messageDialog(t('No se pudo actualizar: ', 'Could not update: ') + String((e && e.message) || e));
  }
}
