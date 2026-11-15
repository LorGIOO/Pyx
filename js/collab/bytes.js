// Small byte helpers shared by the collaboration layer. Pure: no DOM, no
// WebCrypto, so the relay, the tests and the app can all use them.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s) => enc.encode(s);
export const fromUtf8 = (b) => dec.decode(b);

/** Uint8Array → base64url (no padding). */
export function b64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url (or base64) → Uint8Array. Throws on garbage. */
export function fromB64u(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_\-+/]*={0,2}$/.test(str)) {
    throw new Error('base64 no válido');
  }
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536)));
  return b;
}

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function fromHex(s) {
  if (typeof s !== 'string' || s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('hex no válido');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

/** Constant-time-ish equality for short secrets/ids. */
export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
