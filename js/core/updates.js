// Pyx keeps itself up to date from its own GitHub releases (update.rs).
//
//   1. It looks for a new version a little after start-up, every two hours
//      after that, and when the window comes back after a while. The first
//      check waits a different moment on each computer, so a classroom
//      that starts Pyx at the same time does not ask all at once.
//   2. When there is one (and «Actualizar automáticamente» is on), it is
//      downloaded and its SHA-256 checked IN THE BACKGROUND — nothing stops
//      while it happens.
//   3. It is installed when Pyx is closed, or right away from the status bar
//      («Reiniciar para actualizar»): Pyx closes, installs and reopens. The
//      only question ever asked is the one about unsaved documents.
//
// Which releases count (update.rs `choose`): a stable install follows stable
// releases; one that is itself a test version (a pre-release) follows the
// newest release, test versions included. Configuración → General can force
// either.
//
// Windows replaces the program with its installer, macOS the Pyx.app, Linux
// the AppImage. A .deb/.rpm install opens the release page instead (it
// needs root to be replaced).
import { state } from './state.js';
import { invoke, isTauri, openExternal, messageDialog } from './platform.js';
import { t } from './i18n.js';
import { gv } from '../solid/stores/settingsStore.js';

const EVERY = 2 * 60 * 60_000;  // between automatic checks
const ON_FOCUS = 30 * 60_000;   // a window that comes back after this long checks again
const MAX_AUTO_TRIES = 2;       // background downloads of one version before waiting to be asked
let lastCheck = 0;
let checking = null;
let preparing = null;
let lastError = '';
let manual = false;
const failed = new Map();       // version → background downloads that failed

const reason = (e) => String((e && e.message) || e || '').trim();

const channel = () => {
  const c = gv('updateChannel');
  return c === 'stable' || c === 'beta' ? c : 'auto';
};
const automatic = () => gv('autoUpdate') !== false;

/** Ask GitHub whether a newer Pyx exists (silent when offline). With
 *  automatic updates on, a newer one starts downloading in the background. */
export function checkForUpdate() {
  if (!isTauri()) return Promise.resolve(null);
  if (checking) return checking;
  checking = (async () => {
    try {
      const info = await invoke('update_check', { channel: channel() });
      lastCheck = Date.now();
      lastError = '';
      state.update = info && info.newer ? info : null;
      // In the background a version that keeps failing to download is not
      // fetched over and over: after two tries it waits for the button.
      if (state.update && automatic() && (failed.get(info.latest) || 0) < MAX_AUTO_TRIES) prepare(state.update);
      return info;
    } catch (e) {
      // Not counted as a check, so the next tick asks again — but not at
      // once: a refusal answered by asking harder only makes it last.
      lastCheck = Date.now() - EVERY + 10 * 60_000;
      lastError = reason(e);
      return null;
    } finally {
      checking = null;
    }
  })();
  return checking;
}

/** Download and verify `info`'s package in the background (once per version). */
function prepare(info) {
  if (!info.asset || !info.asset.sha256) return Promise.resolve(false);
  if (state.updateReady === info.latest) return Promise.resolve(true);
  if (preparing) return preparing;
  state.updateDownloading = true;
  preparing = invoke('update_download', { asset: info.asset })
    .then(() => { state.updateReady = info.latest; failed.delete(info.latest); state.updateStatus = ''; return true; })
    .catch((e) => {
      failed.set(info.latest, (failed.get(info.latest) || 0) + 1);
      state.updateStatus = t('No se pudo descargar la actualización: ', 'Could not download the update: ') + reason(e);
      return false;
    })
    .finally(() => { state.updateDownloading = false; preparing = null; });
  return preparing;
}

/** Start the automatic checks (main.jsx, once). */
export function startAutoUpdate() {
  if (!isTauri()) return;
  setTimeout(() => { checkForUpdate().catch(() => {}); }, 8000 + Math.floor(Math.random() * 20000));
  setInterval(() => {
    if (Date.now() - lastCheck >= EVERY) checkForUpdate().catch(() => {});
  }, 60_000);
  window.addEventListener('focus', () => {
    if (Date.now() - lastCheck >= ON_FOCUS) checkForUpdate().catch(() => {});
  });
}

/** Close Pyx, install, reopen — after asking about unsaved documents. */
export async function restartToUpdate() {
  const { resolveUnsaved } = await import('../solid/stores/docStore.js');
  const go = await resolveUnsaved({
    title: t('Instalar la actualización', 'Install the update'),
    lead: t(
      `Pyx ${state.updateReady} está descargado y comprobado. Para instalarlo, Pyx se cierra y vuelve a abrirse.`,
      `Pyx ${state.updateReady} is downloaded and verified. Pyx closes and reopens to install it.`,
    ),
  });
  if (!go) {
    state.updateStatus = t('Actualización pospuesta: se instalará al cerrar Pyx.', 'Update postponed: it installs when Pyx closes.');
    return 'cancelled';
  }
  state.updateBusy = true;
  state.updateStatus = t('Instalando… Pyx se cerrará y volverá a abrirse.', 'Installing… Pyx will close and reopen.');
  try {
    await invoke('update_install', { reopen: true });
    return 'installing';
  } catch (e) {
    state.updateBusy = false;
    state.updateStatus = t('No se pudo actualizar.', 'Could not update.');
    await messageDialog(t('No se pudo actualizar: ', 'Could not update: ') + reason(e));
    return 'error';
  }
}

/** Closing Pyx with an update downloaded: install it on the way out (no
 *  reopen). Returns true when the installer took over (Pyx is exiting). */
export async function installOnExit() {
  if (!isTauri() || !state.updateReady) return false;
  try {
    await invoke('update_install', { reopen: false });
    return true;
  } catch (_) {
    return false; // never keep the user from closing
  }
}

/** Status bar button: install now (downloading first if needed). */
export async function installUpdate() {
  const u = state.update;
  if (!u || state.updateBusy) return 'error';
  if (!u.asset) { openExternal(u.page); return 'page'; }
  if (!u.asset.sha256) {
    await messageDialog(t(
      `GitHub no ha publicado la huella SHA-256 del paquete de Pyx ${u.latest}, así que Pyx no puede comprobar la descarga y no la instalará por su cuenta.\n\nSe abrirá la página de la versión para que lo descargues tú.`,
      `GitHub has not published the SHA-256 digest of the Pyx ${u.latest} package, so Pyx cannot verify the download and will not install it by itself.\n\nThe release page will open so you can download it yourself.`,
    ), { title: t('Actualización sin verificar', 'Unverifiable update'), kind: 'warning' });
    openExternal(u.page);
    return 'page';
  }
  if (state.updateReady !== u.latest) {
    state.updateStatus = t(`Descargando Pyx ${u.latest}…`, `Downloading Pyx ${u.latest}…`);
    if (!(await prepare(u))) {
      // Said where the user is looking: the status bar button has no room.
      await messageDialog(state.updateStatus || t('No se pudo descargar la actualización.', 'Could not download the update.'),
        { title: t('Actualización', 'Update'), kind: 'warning' });
      return 'error';
    }
  }
  return restartToUpdate();
}

/** «Buscar actualizaciones» (Configuración → General). */
export async function updateNow() {
  if (!isTauri()) return 'offline';
  // One at a time: a second click while the first is still asking, downloading
  // or showing its question must not start a second installation.
  if (state.updateBusy || manual) return 'busy';
  manual = true;
  try {
    return await updateNowOnce();
  } finally {
    manual = false;
  }
}

async function updateNowOnce() {
  state.updateStatus = t('Buscando…', 'Checking…');
  const info = await checkForUpdate();
  if (!info) {
    // The reason as update.rs gives it: no connection, or GitHub refusing
    // for a while — not always "no connection".
    state.updateStatus = lastError || t('Sin conexión con GitHub.', 'No connection to GitHub.');
    return 'offline';
  }
  if (!info.newer) {
    const kind = info.channel === 'beta' ? t(' (incluidas las versiones de prueba)', ' (test versions included)') : '';
    state.updateStatus = t(`Tienes la última versión (${info.current})${kind}.`, `You have the latest version (${info.current})${kind}.`);
    return 'latest';
  }
  return installUpdate();
}
