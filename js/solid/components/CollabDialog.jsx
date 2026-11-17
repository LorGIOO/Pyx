import { createSignal, createEffect, For, Show, onCleanup } from 'solid-js';
import { state, activeDoc } from '../../core/state.js';
import { collab, notify, inSession } from '../stores/collabStore.js';
import { registerDialog, closeDialogs } from '../stores/dialogStore.js';
import { permLabel } from '../../collab/permissions.js';
import { onPresenceChange, person } from '../../collab/presence-store.js';
import { askDialog, openFolderDialog, isTauri } from '../../core/platform.js';
import { relativeTo } from '../../core/paths.js';

// «Compartir» — start a shared session, join one with a code, and (host)
// manage who is in and what each person may change.

export const openCollab = (tab) => {
  closeDialogs();
  if (tab) collab.tab = tab;
  collab.dialog = true;
};
registerDialog(() => collab.dialog, () => { collab.dialog = false; });

const app = () => import('../../collab/app.js');

export const PERM_OPTIONS = [
  { key: 'both', label: 'Python y LaTeX', perms: { python: true, latex: true } },
  { key: 'latex', label: 'Solo LaTeX', perms: { python: false, latex: true } },
  { key: 'python', label: 'Solo Python', perms: { python: true, latex: false } },
  { key: 'read', label: 'Solo lectura', perms: { python: false, latex: false } },
];
export const permKey = (p) => (p && p.python ? (p.latex ? 'both' : 'python') : (p && p.latex ? 'latex' : 'read'));
const permsOf = (key) => PERM_OPTIONS.find((o) => o.key === key).perms;

export function PermSelect(props) {
  return (
    <select class="collab-perm" value={permKey(props.value)} disabled={props.disabled}
      title="Qué puede modificar esta persona"
      onChange={async (e) => {
        const sel = e.currentTarget;
        const p = permsOf(sel.value);
        if (p.python && !props.value?.python && props.confirmPython !== false) {
          const ok = await askDialog('Con permiso de Python, el código que escriba esta persona se EJECUTARÁ EN TU ORDENADOR al compilar (puede leer y borrar tus archivos). Dáselo solo a alguien de total confianza.\n\n¿Darle permiso de Python?', { title: 'Permiso de Python' });
          if (!ok) { sel.value = permKey(props.value); return; }
        }
        props.onChange(p);
      }}>
      <For each={PERM_OPTIONS}>{(o) => <option value={o.key}>{o.label}</option>}</For>
    </select>
  );
}

export const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

/** Where someone is right now, in words. */
export function whereIs(mid) {
  const p = person(mid);
  const s = p && p.state;
  if (!s) return p && p.online === false ? 'desconectado' : '';
  if (s.p && s.p.z === 'pdf') return `en el PDF · pág. ${s.p.pg}`;
  if (s.f) return `en ${s.f.split('/').pop()}`;
  if (s.p && s.p.z === 'ui') return 'en la interfaz';
  return '';
}

/** A ticking signal so "where is" texts refresh a few times per second. */
export function usePresenceTick() {
  const [tick, setTick] = createSignal(0);
  let t = 0;
  const off = onPresenceChange(() => {
    if (t) return;
    t = setTimeout(() => { t = 0; setTick((n) => n + 1); }, 250);
  });
  onCleanup(() => { off(); clearTimeout(t); });
  return tick;
}

export function MemberList(props) {
  const tick = usePresenceTick();
  return (
    <div class="collab-members">
      <For each={collab.members}>
        {(m) => (
          <div class="collab-member" classList={{ offline: m.online === false }}>
            <span class="collab-avatar" style={{ background: m.color }}>{initials(m.name)}</span>
            <div class="collab-member-main">
              <div class="collab-member-name">
                {m.name}
                <Show when={m.host}><span class="collab-badge">anfitrión</span></Show>
                <Show when={collab.me && m.mid === collab.me.mid}><span class="collab-badge me">tú</span></Show>
              </div>
              <div class="collab-member-where">{(tick(), whereIs(m.mid))}</div>
            </div>
            <Show when={collab.role === 'host' && !m.host} fallback={<span class="collab-perm-text">{m.host ? 'Todo' : permLabel(m.perms)}</span>}>
              <PermSelect value={m.perms} onChange={(p) => app().then((a) => a.setMemberPerms(m.mid, p))} />
              <button class="collab-icon-btn danger" title="Sacar de la sesión (cambia las claves)"
                onClick={async () => { if (await askDialog(`¿Sacar a ${m.name} de la sesión?`, { title: 'Sacar de la sesión' })) app().then((a) => a.kickMember(m.mid)); }}>✕</button>
            </Show>
            <Show when={props.follow && !(collab.me && m.mid === collab.me.mid) && m.online !== false}>
              <button class="collab-icon-btn" classList={{ on: collab.follow === m.mid }}
                title={collab.follow === m.mid ? 'Dejar de seguir' : `Seguir a ${m.name} (ver lo que ve)`}
                onClick={() => import('../../collab/presence-tracker.js').then((t) => t.followPerson(collab.follow === m.mid ? null : m.mid))}>👁</button>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

function ShareForm() {
  const [busy, setBusy] = createSignal(false);
  const [perm, setPerm] = createSignal(permKey(collab.defaultPerms));
  const [folder, setFolder] = createSignal(null);
  const [picked, setPicked] = createSignal(false);
  const doc = () => activeDoc();
  // The project's «carpeta madre», found from what the root document pulls
  // in (chapters in ../capitulos, figures in ../figuras…); the host may pick
  // another one.
  createEffect(() => {
    const d = doc();
    if (picked()) return;
    setFolder(null);
    if (d && !d.kind && d.path) app().then((a) => a.detectShareRoot(d)).then((f) => { if (!picked()) setFolder(f); }).catch(() => {});
  });
  const choose = async () => {
    const d = doc();
    const f = await openFolderDialog(folder());
    if (!f) return;
    if (d && d.path && relativeTo(f, d.path) == null) {
      collab.error = 'La carpeta compartida tiene que contener el documento que compartes.';
      return;
    }
    collab.error = '';
    setPicked(true);
    setFolder(f);
  };
  const start = async () => {
    if (!collab.name.trim()) { collab.error = 'Escribe tu nombre: es lo que verán los demás.'; return; }
    setBusy(true);
    collab.error = '';
    try {
      await (await app()).startHosting({ relay: collab.relay.trim(), name: collab.name.trim(), perms: permsOf(perm()), folder: folder() });
    } catch (e) {
      collab.error = String((e && e.message) || e);
    } finally { setBusy(false); }
  };
  return (
    <div class="collab-form">
      <Show when={doc() && !doc().kind} fallback={<p class="collab-warn">Abre primero el documento que quieres compartir.</p>}>
        <p class="collab-lead">
          Tu Pyx guarda los archivos, ejecuta el Python y compila; los demás ven el PDF al momento.
        </p>
        <div class="collab-field"><span>Carpeta compartida</span>
          <Show when={doc().path} fallback={<p class="collab-hint">Solo <b>{doc().fileName}</b> (aún no está guardado en ninguna carpeta).</p>}>
            <div class="collab-invite">
              <code class="collab-invite-code" title={folder() || ''}>{folder() || 'Buscando la carpeta del proyecto…'}</code>
              <Show when={isTauri()}><button class="ctl-btn" onClick={choose}>Cambiar…</button></Show>
            </div>
            <p class="collab-hint">Todo lo que hay dentro se puede abrir, editar y compilar en la sesión (también los capítulos de carpetas vecinas, con «../»). Lo de fuera, no.</p>
          </Show>
        </div>
      </Show>
      <label class="collab-field"><span>Tu nombre</span>
        <input class="collab-input" value={collab.name} maxLength={40} placeholder="Cómo te verán los demás"
          onInput={(e) => { collab.name = e.currentTarget.value; }} />
      </label>
      <label class="collab-field"><span>Servidor de sesiones</span>
        <input class="collab-input" value={collab.relay} placeholder="wss://relay.tu-dominio.com"
          onInput={(e) => { collab.relay = e.currentTarget.value; }} />
      </label>
      <p class="collab-hint">
        {collab.relay.trim()
          ? 'El servidor solo reenvía datos cifrados: no puede leer tus documentos.'
          : 'Hace falta un servidor de sesiones: pide su dirección (wss://…) a quien administre el tuyo, o monta uno en unos minutos (carpeta «server» del proyecto). Solo reenvía datos cifrados: no puede leer tus documentos.'}
      </p>
      <div class="collab-field"><span>Permiso para quien entre</span>
        <div class="collab-radios">
          <For each={PERM_OPTIONS}>
            {(o) => (
              <label class="collab-radio" classList={{ on: perm() === o.key }}>
                <input type="radio" name="collab-perm" checked={perm() === o.key} onChange={() => setPerm(o.key)} />
                {o.label}
              </label>
            )}
          </For>
        </div>
        <Show when={permsOf(perm()).python}>
          <p class="collab-warn">⚠ Con Python, el código de los invitados se ejecuta en tu ordenador. Úsalo solo con gente de total confianza. Puedes cambiar el permiso de cada persona al aceptarla.</p>
        </Show>
      </div>
      <div class="collab-actions">
        <button class="ctl-btn primary" disabled={busy() || !doc() || doc().kind} onClick={start}>
          {busy() ? 'Preparando…' : 'Empezar a compartir'}
        </button>
      </div>
    </div>
  );
}

function JoinForm() {
  const [code, setCode] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const join = async () => {
    if (!collab.name.trim()) { collab.error = 'Escribe tu nombre: es lo que verán los demás.'; return; }
    setBusy(true);
    collab.error = '';
    try {
      await (await app()).joinSession({ invite: code(), name: collab.name.trim() });
    } catch (e) {
      collab.error = String((e && e.message) || e);
    } finally { setBusy(false); }
  };
  return (
    <div class="collab-form">
      <p class="collab-lead">Pega el código que te ha enviado quien comparte el proyecto. Nada de su documento se ejecuta en tu ordenador.</p>
      <label class="collab-field"><span>Tu nombre</span>
        <input class="collab-input" value={collab.name} maxLength={40} placeholder="Cómo te verán los demás"
          onInput={(e) => { collab.name = e.currentTarget.value; }} />
      </label>
      <label class="collab-field"><span>Código de invitación</span>
        <textarea class="collab-input collab-code-in" rows="3" spellcheck={false} placeholder="pyx1.…"
          value={code()} onInput={(e) => setCode(e.currentTarget.value)} />
      </label>
      <div class="collab-actions">
        <button class="ctl-btn primary" disabled={busy() || !code().trim()} onClick={join}>{busy() ? 'Conectando…' : 'Unirme'}</button>
      </div>
    </div>
  );
}

function HostPanel() {
  const copy = async () => {
    try { await navigator.clipboard.writeText(collab.invite); notify('Código copiado. Envíalo por un canal de confianza.', 'info'); }
    catch (_) { notify('No se pudo copiar: selecciónalo y cópialo a mano.', 'warn'); }
  };
  return (
    <div class="collab-form">
      <div class="collab-field"><span>Código de invitación</span>
        <div class="collab-invite">
          <code class="collab-invite-code" onClick={(e) => { const r = document.createRange(); r.selectNodeContents(e.currentTarget); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }}>{collab.invite}</code>
          <button class="ctl-btn" onClick={copy}>Copiar</button>
        </div>
        <p class="collab-hint">Quien lo tenga puede PEDIR entrar; tú aceptas a cada persona. Para cerrar el paso a todos, termina la sesión.</p>
      </div>
      <Show when={collab.folder}>
        <div class="collab-field"><span>Carpeta compartida</span><code class="collab-invite-code">{collab.folder}</code></div>
      </Show>
      <JoinRequests />
      <div class="collab-field"><span>En la sesión</span><MemberList follow /></div>
      <div class="collab-actions">
        <span class="collab-conn">{connText()}</span>
        <button class="ctl-btn" onClick={() => app().then((a) => a.endSession())}>Terminar la sesión</button>
      </div>
    </div>
  );
}

export function JoinRequests() {
  return (
    <Show when={collab.joins.length}>
      <div class="collab-joins">
        <For each={collab.joins}>{(j) => <JoinCard req={j} />}</For>
      </div>
    </Show>
  );
}

function JoinCard(props) {
  const [perms, setPerms] = createSignal(collab.defaultPerms);
  return (
    <div class="collab-join">
      <div class="collab-join-top">
        <span class="collab-avatar" style={{ background: '#868e96' }}>{initials(props.req.name)}</span>
        <div>
          <div><b>{props.req.name}</b> quiere unirse</div>
          <div class="collab-hint">Código de verificación: <b class="collab-safety">{props.req.code}</b> — si dudas, pídele que te diga el suyo.</div>
        </div>
      </div>
      <div class="collab-join-actions">
        <PermSelect value={perms()} onChange={setPerms} />
        <button class="ctl-btn primary" onClick={() => app().then((a) => a.approveJoin(props.req.id, perms()))}>Aceptar</button>
        <button class="ctl-btn" onClick={() => app().then((a) => a.rejectJoin(props.req.id))}>Rechazar</button>
      </div>
    </div>
  );
}

function GuestPanel() {
  return (
    <div class="collab-form">
      <Show when={collab.phase === 'in'} fallback={
        <div class="collab-waiting">
          <div class="collab-spinner" />
          <p>{collab.phase === 'starting' ? 'Conectando…' : 'Esperando a que el anfitrión te deje pasar…'}</p>
          <Show when={collab.code}>
            <p class="collab-hint">Código de verificación: <b class="collab-safety">{collab.code}</b><br />El anfitrión ve el mismo; si queréis estar seguros, comparadlo.</p>
          </Show>
        </div>
      }>
        <p class="collab-lead">Tu permiso: <b>{permLabel(collab.perms)}</b>. Lo que escribes se guarda en el equipo del anfitrión.</p>
        <div class="collab-field"><span>En la sesión</span><MemberList follow /></div>
      </Show>
      <div class="collab-actions">
        <span class="collab-conn">{connText()}</span>
        <button class="ctl-btn" onClick={() => app().then((a) => a.endSession())}>{collab.phase === 'in' ? 'Salir de la sesión' : 'Cancelar'}</button>
      </div>
    </div>
  );
}

export function connText() {
  switch (collab.conn) {
    case 'open': return '● Conectado';
    case 'connecting': return 'Conectando…';
    case 'reconnecting': return 'Reconectando… (lo que escribas se enviará al volver)';
    case 'host-down': return 'El anfitrión se ha desconectado; esperando…';
    case 'closed': return 'Desconectado';
    default: return '';
  }
}

export default function CollabDialog() {
  return (
    <Show when={collab.dialog}>
      <div class="cfg-overlay">
        <div class="cfg-modal collab-modal">
          <div class="cfg-titlebar">
            <span>{collab.role === 'host' ? 'Compartiendo' : collab.role === 'guest' ? 'Sesión compartida' : 'Trabajar a la vez'}</span>
            <button class="cfg-close" title="Cerrar" onClick={() => { collab.dialog = false; }}>✕</button>
          </div>
          <div class="collab-body">
            <Show when={!inSession() || collab.phase === 'starting' && collab.role === 'host'}>
              <div class="collab-tabs">
                <button classList={{ on: collab.tab === 'share' }} onClick={() => { collab.tab = 'share'; collab.error = ''; }}>Compartir este proyecto</button>
                <button classList={{ on: collab.tab === 'join' }} onClick={() => { collab.tab = 'join'; collab.error = ''; }}>Unirme con un código</button>
              </div>
            </Show>
            <Show when={collab.error}><p class="collab-error">{collab.error}</p></Show>
            <Show when={collab.role === 'host' && collab.phase === 'in'}><HostPanel /></Show>
            <Show when={collab.role === 'guest' && inSession()}><GuestPanel /></Show>
            <Show when={!inSession() || (collab.role === 'host' && collab.phase === 'starting')}>
              {collab.tab === 'join' ? <JoinForm /> : <ShareForm />}
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}

/** Join requests and short notices, visible even with the dialog closed. */
export function CollabOverlay() {
  return (
    <div class="collab-overlay">
      <Show when={collab.role === 'host' && collab.joins.length && !collab.dialog}>
        <div class="collab-float"><JoinRequests /></div>
      </Show>
      <Show when={collab.notice}>
        <div class={`collab-toast ${collab.noticeKind}`} onClick={() => { collab.notice = ''; }}>{collab.notice}</div>
      </Show>
    </div>
  );
}

// state is imported for the side effects of reading activeDoc reactively.
void state;
