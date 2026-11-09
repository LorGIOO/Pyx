// Apply the saved theme before the app renders to avoid a flash.
//
// A CLASSIC script, loaded from <head> with no `defer`/`type="module"`: it
// runs before the first paint. It used to be a module (js/theme-init.js), and
// modules are always deferred — the page could be painted in the default
// light theme first and switch a moment later, a white flash at every start
// for anyone on a dark theme. It lives in public/ so the build copies it as
// it is (Vite only bundles module scripts) and it stays an external file,
// which the Content-Security-Policy allows as 'self'.
try {
  var saved = localStorage.getItem('calc-theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch (_) {
  /* localStorage unavailable — keep the default light theme */
}
