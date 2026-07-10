// Minimal, dependency-free i18n for a two-language UI (Spanish / English).
//
// Every user-facing string is written as `t('texto español', 'english text')`.
// `t` reads a Solid signal, so any string used inside JSX (as text or as a
// component prop) updates LIVE when the language changes — no reload, no lost
// work. Module-level string tables (snippets, symbols, shortcut names) are
// written as FACTORY functions, e.g. `export const FOO = () => [...]`, and
// called at the point of use so they re-evaluate in the active language too.
//
// Default is Spanish (the app's original language); English is opt-in and
// remembered in localStorage.

import { createSignal } from 'solid-js';

const KEY = 'pyx-lang';
const initial = (() => {
  try { return localStorage.getItem(KEY) === 'en' ? 'en' : 'es'; } catch (_) { return 'es'; }
})();

const [lang, setLangSignal] = createSignal(initial);

export { lang };

/** Pick the string for the active language. */
export function t(es, en) {
  return lang() === 'en' ? en : es;
}

/** Change the UI language (persisted). Reactive: the UI re-renders in place. */
export function setLang(l) {
  const v = l === 'en' ? 'en' : 'es';
  try { localStorage.setItem(KEY, v); } catch (_) { /* ignore */ }
  setLangSignal(v);
  try { document.documentElement.lang = v; } catch (_) { /* ignore */ }
}

// Reflect the initial choice on <html lang> for accessibility / spell-check.
try { document.documentElement.lang = initial; } catch (_) { /* ignore */ }
