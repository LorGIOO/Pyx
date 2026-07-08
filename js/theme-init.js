// Apply the saved theme before the app renders to avoid a flash.
try {
  const saved = localStorage.getItem('calc-theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch (_) {
  /* localStorage unavailable — keep the default light theme */
}
