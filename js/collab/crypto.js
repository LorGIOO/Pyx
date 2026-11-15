// End-to-end encryption for shared sessions (WebCrypto only).
//
// THREAT MODEL, in one paragraph. The relay server forwards bytes between the
// host and the guests and must learn nothing from them: it never holds a key.
// The invite code carries a 256-bit secret after the room id; the relay sees
// the room id (it routes on it) but never the secret. From that secret both
// sides derive the INVITE key, used only for the join handshake. The guest
// sends an ephemeral ECDH P-256 public key under it; the host, once a person
// has approved the join, answers with its own, and both derive a PAIR key
// (ECDH + HKDF) that protects everything between that guest and the host.
// Everything the host sends to all guests at once goes under a GROUP key
// that travels to each guest over its pair channel and is replaced whenever
// someone is expelled, so a removed guest cannot read what follows even if it
// keeps listening at the relay.
//
// Every envelope is AES-256-GCM with a fresh random IV. The additional data
// binds the room, the channel and the direction, so a ciphertext cannot be
// replayed into another room or bounced back to its sender, and the plaintext
// begins with a per-channel sequence number the receiver checks (replays and
// reordering by a malicious relay are rejected).

import { utf8, concat, randomBytes } from './bytes.js';

const subtle = () => {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error('Este entorno no tiene WebCrypto: no se puede cifrar la sesión.');
  return s;
};

export const CH_INVITE = 1;
export const CH_PAIR = 2;
export const CH_GROUP = 3;

async function hkdfKey(secretBytes, salt, info) {
  const base = await subtle().importKey('raw', secretBytes, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(salt), info: utf8(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** The key that protects the join handshake, from the invite secret. */
export function inviteKey(secret, room) {
  return hkdfKey(secret, `pyx-room:${room}`, 'pyx invite v1');
}

/** A fresh random group key (raw bytes, so it can be sent to guests). */
export function newGroupSecret() {
  return randomBytes(32);
}

export async function groupKey(raw, room, epoch) {
  return hkdfKey(raw, `pyx-room:${room}`, `pyx group v1 #${epoch}`);
}

/** Ephemeral ECDH key pair for one handshake. */
export async function ecdhPair() {
  const kp = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
  return { priv: kp.privateKey, pub };
}

/** Pair key from my private key and the other side's raw public key. Both
 *  sides pass the guest's key first, so they derive the same bytes. */
export async function pairKey(myPriv, theirPubRaw, room, guestPub, hostPub) {
  const theirs = await subtle().importKey('raw', theirPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: theirs }, myPriv, 256));
  return hkdfKey(concat(bits, guestPub, hostPub), `pyx-room:${room}`, 'pyx pair v1');
}

/** Six digits both people can read to each other to be sure nobody sits in
 *  between: derived from both public keys, the same on both screens. */
export async function safetyCode(guestPub, hostPub) {
  const h = new Uint8Array(await subtle().digest('SHA-256', concat(utf8('pyx safety v1'), guestPub, hostPub)));
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  const s = String(n % 1_000_000).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle().digest('SHA-256', bytes));
}

const aad = (room, chan, dir, epoch) => utf8(`pyx1|${room}|${chan}|${dir}|${epoch}`);

/**
 * Seal `plain` into an envelope: [chan u8][epoch u32][iv 12][ciphertext].
 * `seq` is prepended to the plaintext (8 bytes) for replay protection.
 */
export async function seal(key, { room, chan, dir, epoch = 0, seq }, plain) {
  const iv = randomBytes(12);
  const head = new Uint8Array(8);
  new DataView(head.buffer).setFloat64(0, seq);
  const ct = new Uint8Array(await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(room, chan, dir, epoch) },
    key,
    concat(head, plain),
  ));
  const out = new Uint8Array(1 + 4 + 12 + ct.length);
  out[0] = chan;
  new DataView(out.buffer).setUint32(1, epoch >>> 0);
  out.set(iv, 5);
  out.set(ct, 17);
  return out;
}

/** Read an envelope's cleartext header (channel, epoch) without decrypting. */
export function peek(env) {
  if (!(env instanceof Uint8Array) || env.length < 17 + 16) return null;
  return { chan: env[0], epoch: new DataView(env.buffer, env.byteOffset, env.byteLength).getUint32(1) };
}

/** Open an envelope. Returns { seq, plain } or throws (tampered, wrong key). */
export async function open(key, { room, chan, dir, epoch = 0 }, env) {
  const h = peek(env);
  if (!h || h.chan !== chan || h.epoch !== (epoch >>> 0)) throw new Error('sobre no válido');
  const iv = env.subarray(5, 17);
  const ct = env.subarray(17);
  const plain = new Uint8Array(await subtle().decrypt(
    { name: 'AES-GCM', iv, additionalData: aad(room, chan, dir, epoch) },
    key,
    ct,
  ));
  const seq = new DataView(plain.buffer, plain.byteOffset, 8).getFloat64(0);
  return { seq, plain: plain.subarray(8) };
}
