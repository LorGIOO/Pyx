// The session server Pyx proposes when nobody has typed one.
//
// Shared sessions need a relay (server/relay.mjs): a small server that only
// forwards encrypted bytes. With an address here, «Compartir» works out of
// the box for every user — they never see or type a server address (they can
// still change it). Left empty, each host must type the address of their own.
//
// HOW TO FILL IT IN: deploy the relay once (server/README.md: Render, Fly.io
// or any machine with Docker) and write its address below, for example
//   export const DEFAULT_RELAY = 'wss://pyx-relay.onrender.com';
// It must start with wss:// (TLS). Nothing else in the app needs to change.
export const DEFAULT_RELAY = '';

/** `url` if it is a usable relay address, else ''. */
export function validRelay(url) {
  const u = String(url || '').trim();
  if (/^wss:\/\/[^\s/]+/i.test(u)) return u;
  // Without TLS only on this very machine (trying things out).
  if (/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u)) return u;
  return '';
}
