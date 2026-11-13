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

/** «Buscar actualizaciones» (Configuración → General): ask GitHub and, if a
 *  newer Pyx exists, install it the whole way without further questions —
 *  download, SHA-256 check, install, reopen — like VS Code's «Restart to
 *  update». The only question left is the one about unsaved documents.
 *  Returns what happened, for the button to say it:
 *  'latest' | 'offline' | 'installing' | 'cancelled' | 'error' | 'page'. */
export async function updateNow() {
  if (!isTauri()) return 'offline';
  state.updateStatus = t('Buscando…', 'Checking…');
  const info = await checkForUpdate();
  if (!info) { state.updateStatus = t('Sin conexión con GitHub.', 'No connection to GitHub.'); return 'offline'; }
  if (!info.newer) {
    state.updateStatus = t(`Tienes la última versión (${info.current}).`, `You have the latest version (${info.current}).`);
    return 'latest';
  }
  state.updateStatus = t(`Descargando Pyx ${info.latest}…`, `Downloading Pyx ${info.latest}…`);
  return installUpdate({ ask: false });
}

/** Install the update checkForUpdate found.
 *
 *  Two steps, with the unsaved-documents question BETWEEN them. The installer
 *  closes Pyx (`app.exit`, which no close handler sees), and the download
 *  takes long enough to keep working meanwhile: checking only before it — as
 *  this used to — let everything typed during the download be lost. */
export async function installUpdate({ ask = true } = {}) {
  const u = state.update;
  if (!u || state.updateBusy) return 'error';
  if (!u.asset) {
    openExternal(u.page);
    return 'page';
  }
  // No published SHA-256: Pyx will not run an installer it cannot verify
  // (update.rs refuses it too). The release page is the way.
  if (!u.asset.sha256) {
    await messageDialog(t(
      `GitHub no ha publicado la huella SHA-256 del instalador de Pyx ${u.latest}, así que Pyx no puede comprobar la descarga y no la instalará por su cuenta.\n\nSe abrirá la página de la versión para que lo descargues tú.`,
      `GitHub has not published the SHA-256 digest of the Pyx ${u.latest} installer, so Pyx cannot verify the download and will not install it by itself.\n\nThe release page will open so you can download it yourself.`,
    ), { title: t('Actualización sin verificar', 'Unverifiable update'), kind: 'warning' });
    openExternal(u.page);
    return 'page';
  }
  if (ask && !(await askDialog(t(
    `Pyx ${u.latest} está disponible (tienes la ${u.current}).\n\nSe descargará y se comprobará mientras sigues trabajando; después Pyx se cerrará para instalarla y volverá a abrirse solo. ¿Actualizar ahora?`,
    `Pyx ${u.latest} is available (you have ${u.current}).\n\nIt is downloaded and verified while you keep working; then Pyx closes to install it and reopens by itself. Update now?`,
  ), { kind: 'info' }))) return 'cancelled';
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
      state.updateStatus = t('Actualización pospuesta.', 'Update postponed.');
      return 'cancelled';
    }
    state.updateStatus = t('Instalando… Pyx se cerrará y volverá a abrirse.', 'Installing… Pyx will close and reopen.');
    await invoke('update_install');
    return 'installing';
  } catch (e) {
    state.updateBusy = false;
    state.updateStatus = t('No se pudo actualizar.', 'Could not update.');
    await messageDialog(t('No se pudo actualizar: ', 'Could not update: ') + String((e && e.message) || e));
    return 'error';
  }
}
