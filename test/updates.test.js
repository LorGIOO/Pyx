// @vitest-environment jsdom
// «Buscar actualizaciones» (core/updates.js): what the user is told, and
// that neither a refusal from GitHub nor an impatient second click makes it
// misbehave.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ calls: [], check: null, download: null, install: null, dialogs: [], opened: [], unsaved: true }));

vi.mock('../js/core/platform.js', async (orig) => ({
  ...(await orig()),
  isTauri: () => true,
  invoke: async (cmd, args) => {
    h.calls.push(cmd);
    if (cmd === 'update_check') return h.check(args);
    if (cmd === 'update_download') return h.download(args);
    if (cmd === 'update_install') return h.install(args);
    return null;
  },
  messageDialog: async (text) => { h.dialogs.push(text); },
  openExternal: (url) => { h.opened.push(url); },
}));
vi.mock('../js/solid/stores/docStore.js', () => ({ resolveUnsaved: async () => h.unsaved }));

const { state } = await import('../js/core/state.js');
const { general } = await import('../js/solid/stores/settingsStore.js');
const up = await import('../js/core/updates.js');

const asset = { name: 'Pyx_2.1.0_x64-setup.exe', url: 'u', size: 3, sha256: 'ab'.repeat(32), kind: 'nsis' };
const newer = (extra = {}) => ({ current: '2.0.0', latest: '2.1.0', newer: true, prerelease: false, channel: 'stable', notes: '', page: 'https://page', asset, ...extra });
const count = (cmd) => h.calls.filter((c) => c === cmd).length;

beforeEach(() => {
  h.calls.length = 0; h.dialogs.length = 0; h.opened.length = 0; h.unsaved = true;
  h.check = async () => ({ current: '2.0.0', latest: '2.0.0', newer: false, channel: 'stable' });
  h.download = async () => null;
  h.install = async () => null;
  Object.assign(state, { update: null, updateReady: null, updateDownloading: false, updateBusy: false, updateStatus: '' });
});

describe('buscar actualizaciones', () => {
  it('says it is up to date', async () => {
    expect(await up.updateNow()).toBe('latest');
    expect(state.updateStatus).toContain('2.0.0');
    expect(count('update_download')).toBe(0);
  });

  it('tells WHY GitHub could not be asked, not always "no connection"', async () => {
    h.check = async () => { throw 'GitHub ha limitado por un rato las consultas desde esta conexión.'; };
    expect(await up.updateNow()).toBe('offline');
    expect(state.updateStatus).toContain('limitado');
    expect(state.update).toBe(null);
  });

  it('downloads, verifies and installs a newer version, asking once', async () => {
    h.check = async () => newer();
    expect(await up.updateNow()).toBe('installing');
    expect(count('update_download')).toBe(1);
    expect(count('update_install')).toBe(1);
    expect(state.updateReady).toBe('2.1.0');
  });

  it('a second click while the first is working starts nothing twice', async () => {
    let release;
    h.check = async () => newer();
    h.download = () => new Promise((r) => { release = r; });
    const first = up.updateNow();
    await vi.waitFor(() => expect(count('update_download')).toBe(1));
    expect(await up.updateNow()).toBe('busy');
    release();
    expect(await first).toBe('installing');
    expect(count('update_download')).toBe(1);
    expect(count('update_install')).toBe(1);
  });

  it('postponing (unsaved documents) keeps the download for later', async () => {
    h.check = async () => newer({ latest: '2.1.1' });
    h.unsaved = false;
    expect(await up.updateNow()).toBe('cancelled');
    expect(count('update_install')).toBe(0);
    expect(state.updateReady).toBe('2.1.1');
    // Closing Pyx installs it without reopening.
    expect(await up.installOnExit()).toBe(true);
    expect(count('update_install')).toBe(1);
  });

  it('a package this system cannot install by itself opens the release page', async () => {
    h.check = async () => newer({ latest: '2.2.0', asset: null });
    expect(await up.updateNow()).toBe('page');
    expect(h.opened).toEqual(['https://page']);
    expect(count('update_download')).toBe(0);
  });

  it('never installs a package without a published SHA-256', async () => {
    h.check = async () => newer({ latest: '2.3.0', asset: { ...asset, sha256: null } });
    expect(await up.updateNow()).toBe('page');
    expect(count('update_download')).toBe(0);
    expect(count('update_install')).toBe(0);
    expect(h.dialogs[0]).toContain('SHA-256');
  });

  it('a failed download is explained, and not retried forever in the background', async () => {
    general.autoUpdate = true;
    h.check = async () => newer({ latest: '2.4.0' });
    h.download = async () => { throw 'La descarga está incompleta: inténtalo de nuevo.'; };
    for (let i = 0; i < 5; i++) {
      await up.checkForUpdate();
      await vi.waitFor(() => expect(state.updateDownloading).toBe(false));
    }
    expect(count('update_download')).toBe(2);
    expect(state.updateStatus).toContain('incompleta');
    // Asked by hand it tries again, and says what went wrong.
    expect(await up.updateNow()).toBe('error');
    expect(count('update_download')).toBe(3);
    expect(h.dialogs.at(-1)).toContain('incompleta');
    // And once it works, it installs.
    h.download = async () => null;
    expect(await up.updateNow()).toBe('installing');
  });

  it('closing Pyx is never blocked by an update that cannot start', async () => {
    state.updateReady = '2.1.0';
    h.install = async () => { throw 'No hay ninguna actualización descargada y comprobada.'; };
    expect(await up.installOnExit()).toBe(false);
  });
});
