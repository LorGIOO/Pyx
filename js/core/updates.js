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

/** Install the update checkForUpdate found.
 *
 *  Two steps, with the unsaved-documents question BETWEEN them. The installer
 *  closes Pyx (`app.exit`, which no close handler sees), and the download
 *  takes long enough to keep working meanwhile: checking only before it — as
 *  this used to — let everything typed during the download be lost. */
export async function installUpdate() {
  const u = state.update;
  if (!u || state.updateBusy) return;
  if (!u.asset) {
    openExternal(u.page);
    return;
  }
  // No published SHA-256: Pyx will not run an installer it cannot verify
  // (update.rs refuses it too). The release page is the way.
  if (!u.asset.sha256) {
    await messageDialog(t(
      `GitHub no ha publicado la huella SHA-256 del instalador de Pyx ${u.latest}, así que Pyx no puede comprobar la descarga y no la instalará por su cuenta.\n\nSe abrirá la página de la versión para que lo descargues tú.`,
      `GitHub has not published the SHA-256 digest of the Pyx ${u.latest} installer, so Pyx cannot verify the download and will not install it by itself.\n\nThe release page will open so you can download it yourself.`,
    ), { title: t('Actualización sin verificar', 'Unverifiable update'), kind: 'warning' });
    openExternal(u.page);
    return;
  }
  if (!(await askDialog(t(
    `Pyx ${u.latest} está disponible (tienes la ${u.current}).\n\nSe descargará y se comprobará mientras sigues trabajando; después Pyx se cerrará para instalarla y volverá a abrirse solo. ¿Actualizar ahora?`,
    `Pyx ${u.latest} is available (you have ${u.current}).\n\nIt is downloaded and verified while you keep working; then Pyx closes to install it and reopens by itself. Update now?`,
  ), { kind: 'info' }))) return;
  state.updateBusy = true;
  try {
    await invoke('update_download', { asset: u.asset });
    // Now — with the installer verified and ready — is when closing matters.
    const { resolveUnsaved } = await import('../solid/stores/docStore.js');
    const go = await resolveUnsaved({
      title: t('Instalar la actualización', 'Install the update'),
      lead: t(
        `Pyx ${u.latest} está descargado y comprobado. Para instalarlo, Pyx se cierra.`,
        `Pyx ${u.latest} is downloaded and verified. Pyx closes to install it.`,
      ),
    });
    if (!go) {
      // Cancelled: nothing is installed. The status bar keeps offering it.
      state.updateBusy = false;
      return;
    }
    await invoke('update_install');
  } catch (e) {
    state.updateBusy = false;
    await messageDialog(t('No se pudo actualizar: ', 'Could not update: ') + String((e && e.message) || e));
  }
}
