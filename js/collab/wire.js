// Message framing inside an encrypted envelope, and the invite code format.
//
// A message is a small JSON header (`t` = type, plus fields) and an optional
// binary body (a Yjs update, PDF chunks): [u32 headerLen][header][body].
// Binary stays binary — no base64 inflation for the hot paths.

import { utf8, fromUtf8, b64u, fromB64u, randomBytes } from './bytes.js';

const MAX_HEADER = 1 << 20; // 1 MB of JSON is already absurd for a header

export function pack(header, body = null) {
  const h = utf8(JSON.stringify(header));
  const b = body || new Uint8Array(0);
  const out = new Uint8Array(4 + h.length + b.length);
  new DataView(out.buffer).setUint32(0, h.length);
  out.set(h, 4);
  out.set(b, 4 + h.length);
  return out;
}

export function unpack(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) throw new Error('mensaje corto');
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (n > MAX_HEADER || 4 + n > bytes.length) throw new Error('cabecera no válida');
  const header = JSON.parse(fromUtf8(bytes.subarray(4, 4 + n)));
  if (!header || typeof header !== 'object' || typeof header.t !== 'string') throw new Error('mensaje sin tipo');
  return { header, body: bytes.subarray(4 + n) };
}

/* ---------- invite codes ----------
 *
 *   pyx1.<relay url, base64url>.<room id>.<secret, base64url>
 *
 * One token, nothing to escape, pasteable in a chat. The relay only ever
 * learns the room id; the secret never leaves the two Pyx windows. */

export function newRoomId() {
  return b64u(randomBytes(16));
}

export function makeInvite(relayUrl, room, secret) {
  return `pyx1.${b64u(utf8(relayUrl))}.${room}.${b64u(secret)}`;
}

/** Parse an invite code. Returns { relay, room, secret } or throws a message
 *  meant for the person who pasted it. */
export function parseInvite(code) {
  const s = String(code || '').trim().replace(/\s+/g, '');
  const m = /^pyx1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{40,64})$/.exec(s);
  if (!m) throw new Error('El código de invitación no es válido. Copia el código completo que te envió el anfitrión.');
  let relay;
  try { relay = fromUtf8(fromB64u(m[1])); } catch (_) { throw new Error('El código de invitación está dañado.'); }
  if (!/^wss?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(relay)) throw new Error('El servidor del código de invitación no es válido.');
  // Plain ws:// only to this machine (development); anything else must be TLS.
  if (/^ws:\/\//i.test(relay) && !/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(relay)) {
    throw new Error('El servidor debe usar una conexión cifrada (wss://).');
  }
  const secret = fromB64u(m[3]);
  if (secret.length !== 32) throw new Error('El código de invitación está dañado.');
  return { relay, room: m[2], secret };
}
