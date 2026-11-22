import { createSignal, For, Show, onMount } from 'solid-js';
import { t } from '../../core/i18n.js';

// Pyx's own message / question / text-input dialog, in the app's style (the
// Configuración chrome), instead of the browser's prompt() or the operating
// system's message boxes. platform.js routes messageDialog, askDialog,
// choiceDialog and promptDialog here once this host is on screen.
//
// One dialog at a time; later ones wait in a queue. Enter answers with the
// primary button, Escape with the cancel one (or closes a plain message).

const [current, setCurrent] = createSignal(null);
const queue = [];
let mounted = false;
export const appDialogReady = () => mounted;

/**
 * Show a dialog. `buttons`: [{ id, label, primary?, danger? }]; the answer
 * is the id of the button pressed, or `cancelId` on Escape. With `input`,
 * the answer is { id, value }.
 */
export function showAppDialog(o) {
  return new Promise((resolve) => {
    queue.push({ ...o, resolve });
    if (!current()) next();
  });
}
function next() { setCurrent(queue.shift() || null); }

const ICON = {
  info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.3"/><path d="M8 7v4.2M8 4.9v.1" stroke-linecap="round"/></svg>',
  warning: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M8 1.8 15 14H1z"/><path d="M8 6.2v3.6M8 11.6v.1" stroke-linecap="round"/></svg>',
  error: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.3"/><path d="m5.6 5.6 4.8 4.8m0-4.8-4.8 4.8" stroke-linecap="round"/></svg>',
};

export default function AppDialog() {
  onMount(() => { mounted = true; });
  let inputEl;
  const [value, setValue] = createSignal('');
  const answer = (id) => {
    const d = current();
    if (!d) return;
    d.resolve(d.input ? { id, value: value() } : id);
    next();
  };
  const primary = () => (current().buttons.find((b) => b.primary) || current().buttons[0]).id;
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); answer(current().cancelId ?? 'cancel'); }
    else if (e.key === 'Enter' && !e.shiftKey && !(e.target && e.target.tagName === 'TEXTAREA')) { e.preventDefault(); answer(primary()); }
  };
  return (
    <Show when={current()}>
      {(d) => {
        setValue(d().input ? d().input.value || '' : '');
        return (
          <div class="cfg-overlay app-dialog-overlay" onKeyDown={onKey}>
            <div class="cfg-modal app-dialog" role="dialog" aria-modal="true"
              ref={(el) => requestAnimationFrame(() => {
                if (inputEl) { inputEl.focus(); inputEl.select(); } else el.querySelector('button.primary, .app-dialog-foot button')?.focus();
              })}>
              <div class="cfg-titlebar"><span>{d().title || 'Pyx'}</span>
                <button class="cfg-close" title={t('Cerrar', 'Close')} onClick={() => answer(d().cancelId ?? 'cancel')}>✕</button>
              </div>
              <div class="app-dialog-body">
                <Show when={d().kind && ICON[d().kind]}>
                  <span class={`app-dialog-ico ${d().kind}`} innerHTML={ICON[d().kind]} />
                </Show>
                <div class="app-dialog-text">
                  <Show when={d().message}><p class="app-dialog-msg">{d().message}</p></Show>
                  <Show when={d().input}>
                    <input ref={inputEl} type="text" class="app-dialog-input" value={value()} spellcheck={false}
                      placeholder={d().input.placeholder || ''} onInput={(e) => setValue(e.target.value)} />
                  </Show>
                </div>
              </div>
              <div class="cfg-footer app-dialog-foot">
                <For each={d().buttons}>
                  {(b) => <button class={b.primary ? 'primary' : b.danger ? 'danger' : ''} onClick={() => answer(b.id)}>{b.label}</button>}
                </For>
              </div>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
