// A shared session: one HOST (whose machine holds the files, runs Python and
// compiles) and up to a few dozen GUESTS, connected through the relay.
//
// This module is the protocol only — no DOM, no CodeMirror, no Tauri. The app
// plugs in through an `adapter` (collab/app.js); the tests plug in plain
// Y.Docs. That separation is what lets the security rules be tested for real.
//
// THE HOST IS THE AUTHORITY. Guests never talk to each other: everything a
// guest sends reaches the host only, and the host checks it — who may join
// (a person approves every new guest), what each guest may change (Python,
// LaTeX, both or nothing, checked against the real text before and after),
// which Yjs client ids belong to whom — before passing it on to the rest.
//
// Text is a Yjs CRDT per file: everyone types on their own copy with zero
// latency and the copies converge, whatever the order the edits arrive in.
// Only the files someone has open travel, so a project of hundreds of files
// costs what the open ones cost.

import * as Y from 'yjs';
import { RelayClient } from './relay-client.js';
import * as C from './crypto.js';
import { pack, unpack, newRoomId, makeInvite, parseInvite } from './wire.js';
import { b64u, fromB64u, randomBytes, hex } from './bytes.js';
import { allowedChange, normPerms, PERM_NONE, quickVerdict } from './permissions.js';
import { chunkify, ChunkCache } from './cdc.js';
import { cleanPresence, cleanName, COLORS } from './presence-format.js';

export const PROTOCOL = 1;
export const ORIGIN_NET = Symbol('pyx-net');      // an update that came from the network
const MAX_UPDATE = 1024 * 1024;                   // one Yjs update from a guest
const MAX_DOC = 32 * 1024 * 1024;                 // a shared text may not grow past this
const BATCH_MS = 16;                              // edits are merged per frame
const PRESENCE_MS = 33;                           // ~30 presence updates per second
const BLOB_BATCH = 900 * 1024;                    // chunk bytes per message (relay limit is 2 MB)

/** Serialize async work in arrival order (decryption must not reorder). */
class Serial {
  constructor() { this.p = Promise.resolve(); }
  run(fn) {
    const next = this.p.then(fn, fn);
    this.p = next.catch(() => {});
    return next;
  }
}

/** One direction-aware encrypted channel with replay protection. */
class Chan {
  constructor(key, room, chan, out, inn, epoch = 0) {
    Object.assign(this, { key, room, chan, out, inn, epoch });
    this.seq = 0;
    this.last = -1;
  }
  seal(bytes) {
    return C.seal(this.key, { room: this.room, chan: this.chan, dir: this.out, epoch: this.epoch, seq: ++this.seq }, bytes);
  }
  async open(env) {
    const { seq, plain } = await C.open(this.key, { room: this.room, chan: this.chan, dir: this.inn, epoch: this.epoch }, env);
    if (!(seq > this.last)) throw new Error('mensaje repetido');
    this.last = seq;
    return plain;
  }
}

const msg = (t, fields = {}, body = null) => pack({ t, ...fields }, body);

/* Big messages (the first copy of a long document, a large output) are cut
 * into fragments: the relay takes frames of up to 2 MB, and a frame that big
 * would also hold everything queued behind it. Fragments travel in order on
 * the same channel and are put back together on arrival. */
const FRAG = 256 * 1024;
const MAX_REASSEMBLY = 96 * 1024 * 1024;
let fragSeq = 0;

function fragments(bytes) {
  if (bytes.length <= FRAG) return [bytes];
  const id = ++fragSeq;
  const n = Math.ceil(bytes.length / FRAG);
  const out = [];
  for (let i = 0; i < n; i++) out.push(pack({ t: 'frag', id, i, n }, bytes.subarray(i * FRAG, (i + 1) * FRAG)));
  return out;
}

class Reassembler {
  constructor() { this.cur = null; }
  /** A fragment arrived: the whole message once complete, else null. */
  take(h, body) {
    if (!(h.n > 1) || !(h.i >= 0) || h.i >= h.n || h.n * FRAG > MAX_REASSEMBLY) { this.cur = null; return null; }
    if (h.i === 0) this.cur = { id: h.id, n: h.n, parts: [], size: 0 };
    const c = this.cur;
    if (!c || c.id !== h.id || c.parts.length !== h.i) { this.cur = null; return null; }
    c.parts.push(body.slice());
    c.size += body.length;
    if (c.parts.length < c.n) return null;
    this.cur = null;
    const all = new Uint8Array(c.size);
    let o = 0;
    for (const p of c.parts) { all.set(p, o); o += p.length; }
    return unpack(all);
  }
}

/** Pending edits of one document, merged and sent once per frame. */
class Batcher {
  constructor(flush) { this.flush = flush; this.parts = new Map(); this.timer = 0; }
  add(key, update) {
    let a = this.parts.get(key);
    if (!a) { a = []; this.parts.set(key, a); }
    a.push(update);
    if (!this.timer) this.timer = setTimeout(() => this.run(), BATCH_MS);
  }
  run() {
    this.timer = 0;
    const parts = this.parts;
    this.parts = new Map();
    for (const [key, list] of parts) this.flush(key, list.length === 1 ? list[0] : Y.mergeUpdates(list));
  }
  clear() { clearTimeout(this.timer); this.timer = 0; this.parts.clear(); }
}

const isPath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 512;

/** A member list from the host, made safe to show: a color is a color (not
 *  a `url(…)` that would make this window fetch something), names bounded. */
function cleanMembers(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 64).filter((m) => m && typeof m.mid === 'string').map((m) => ({
    mid: m.mid.slice(0, 32),
    name: cleanName(m.name),
    color: /^#[0-9a-f]{3,8}$/i.test(m.color) ? m.color : '#868e96',
    perms: normPerms(m.perms),
    online: m.online !== false,
    host: !!m.host,
  }));
}

/* ======================================================================
 * HOST
 * ==================================================================== */

export class HostSession {
  /**
   * @param {object} o
   * @param {string} o.relay                 wss:// URL of the relay
   * @param {string} o.name                  the host's display name
   * @param {object} o.adapter
   *   openDoc(path) → Promise<Y.Doc>        the shared Y.Doc of a project file
   *   fileName(path) → string               for the permission rules
   *   files() → [{path}]                    the project's editable files
   *   joinRequest({id, name, code})         ask a person (approve()/reject())
   *   onMembers(list), onPresence(mid, state), onStatus(s, detail)
   *   compileRequest(member), rpc(member, method, args) → Promise
   *   denied(member, path, why)
   */
  constructor(o) {
    this.o = o;
    this.a = o.adapter;
    this.name = cleanName(o.name);
    this.members = new Map();   // relay id (hex) → member
    this.byMid = new Map();     // stable member id → member
    this.pending = new Map();   // relay id → join request
    this.inviteIn = new Map();  // relay id → Chan (invite channel per peer)
    this.docs = new Map();      // path → { ydoc, ytext, onUpdate }
    this.clientOwner = new Map(); // Yjs clientID → mid ('host' for this machine)
    this.serial = new Serial();
    this.out = new Serial();
    this.batch = new Batcher((path, u) => this.broadcast(msg('u', { path }, u)));
    this.presence = new Map();  // mid → state (dirty ones are flushed)
    this.presenceDirty = new Set();
    this.presenceTimer = 0;
    this.blobs = new ChunkCache(384 * 1024 * 1024);
    this.blobSent = new Set();  // chunk hashes broadcast in the current group epoch
    this.lastBlob = new Map();  // kind:key → manifest (late joiners get it)
    this.colorAt = 1;
    this.status = 'idle';
    this.ended = false;
  }

  /** Create the room and return the invite code. */
  async start() {
    this.room = newRoomId();
    this.token = b64u(randomBytes(32));
    this.secret = randomBytes(32);
    this.inviteKey = await C.inviteKey(this.secret, this.room);
    await this.rotateGroup(false);
    this.invite = makeInvite(this.o.relay, this.room, this.secret);
    this.relay = new RelayClient({
      url: this.o.relay,
      room: this.room,
      role: 'host',
      token: this.token,
      WebSocket: this.o.WebSocket,
      onControl: (c) => this.onControl(c),
      onBinary: (type, from, payload) => {
        if (type === 0x10 && from) this.serial.run(() => this.onGuestFrame(hex(from), from, payload)).catch(() => {});
      },
      onStatus: (s, d) => { this.status = s; if (this.a.onStatus) this.a.onStatus(s, d); },
    });
    this.relay.connect();
    return this.invite;
  }

  async rotateGroup(announce = true) {
    const epoch = this.group ? this.group.epoch + 1 : 1;
    const raw = C.newGroupSecret();
    const key = await C.groupKey(raw, this.room, epoch);
    this.group = { epoch, raw, chan: new Chan(key, this.room, C.CH_GROUP, 'h2a', 'h2a', epoch) };
    this.blobSent.clear();
    if (announce) {
      for (const m of this.members.values()) {
        if (m.online) this.sendTo(m, msg('gkey', { epoch, k: b64u(raw) }));
      }
    }
  }

  /* ---------- relay events ---------- */

  onControl(c) {
    if (c.t === 'ready') {
      // A reconnect: the relay forgot nobody, but tell it again who is in.
      for (const m of this.members.values()) if (m.online) this.relay.control({ t: 'admit', id: m.id });
      return;
    }
    if (c.t === 'peer' && c.ev === 'leave') {
      this.pending.delete(c.id);
      this.inviteIn.delete(c.id);
      const m = this.members.get(c.id);
      if (m) this.memberGone(m, false);
    }
  }

  memberGone(m, forever) {
    m.online = false;
    this.members.delete(m.id);
    if (forever) this.byMid.delete(m.mid);
    this.setPresence(m.mid, null);
    this.announceMembers();
  }

  /* ---------- sending ---------- */

  broadcast(bytes) {
    return this.out.run(async () => {
      if (this.ended) return;
      for (const f of fragments(bytes)) this.relay.broadcast(await this.group.chan.seal(f));
    });
  }

  sendTo(m, bytes) {
    return this.out.run(async () => {
      if (!m.chan || this.ended) return;
      for (const f of fragments(bytes)) this.relay.sendTo(m.idBytes, await m.chan.seal(f));
    });
  }

  sendInvite(id, idBytes, bytes) {
    return this.out.run(async () => {
      let ch = this.inviteIn.get(id);
      if (!ch) return;
      const env = await ch.seal(bytes);
      this.relay.sendTo(idBytes, env);
    });
  }

  /* ---------- incoming ---------- */

  async onGuestFrame(id, idBytes, env) {
    const h = C.peek(env);
    if (!h) return;
    if (h.chan === C.CH_INVITE) {
      let ch = this.inviteIn.get(id);
      if (!ch) { ch = new Chan(this.inviteKey, this.room, C.CH_INVITE, 'h2g', 'g2h'); this.inviteIn.set(id, ch); }
      let plain;
      try { plain = await ch.open(env); } catch (_) { return; } // not someone with the invite
      const { header } = unpack(plain);
      if (header.t === 'join') await this.onJoin(id, idBytes, header);
      return;
    }
    if (h.chan !== C.CH_PAIR) return;
    const m = this.members.get(id);
    if (!m || !m.chan) return;
    let plain;
    try { plain = await m.chanIn.open(env); } catch (_) { return; }
    let parsed;
    try { parsed = unpack(plain); } catch (_) { return; }
    if (parsed.header.t === 'frag') {
      if (!m.reasm) m.reasm = new Reassembler();
      try { parsed = m.reasm.take(parsed.header, parsed.body); } catch (_) { parsed = null; }
      if (!parsed) return;
    }
    await this.onMember(m, parsed.header, parsed.body);
  }

  async onJoin(id, idBytes, j) {
    if (this.members.has(id) || this.pending.has(id)) return;
    let pub;
    try { pub = fromB64u(String(j.pub || '')); } catch (_) { return; }
    if (pub.length !== 65 || j.v !== PROTOCOL) {
      await this.sendInvite(id, idBytes, msg('reject', { why: j.v !== PROTOCOL ? 'version' : 'bad' }));
      return;
    }
    // Coming back after a network blip: the resume token proves it is the
    // same person the host already let in — no second approval.
    if (typeof j.resume === 'string') {
      for (const m of this.byMid.values()) {
        if (m.resume === j.resume && !m.online) {
          await this.admit(m, id, idBytes, pub);
          return;
        }
      }
    }
    const host = await C.ecdhPair();
    const code = await C.safetyCode(pub, host.pub);
    const req = { id, idBytes, name: cleanName(j.name), pub, host, code };
    this.pending.set(id, req);
    // Our half of the key exchange goes out NOW, before anyone approves: it
    // lets the guest show the same safety code the host is looking at while
    // deciding. It grants nothing — nothing is sent under that key until a
    // person says yes.
    await this.sendInvite(id, idBytes, msg('welcome', { pub: b64u(host.pub) }));
    this.a.joinRequest({ id, name: req.name, code });
  }

  /** A person said yes. `perms` = { python, latex }. */
  async approve(id, perms) {
    const req = this.pending.get(id);
    if (!req) return false;
    this.pending.delete(id);
    const m = {
      mid: b64u(randomBytes(9)),
      name: req.name,
      color: COLORS[this.colorAt++ % COLORS.length],
      perms: normPerms(perms),
      resume: b64u(randomBytes(24)),
      subs: new Set(),
      origin: null,
      online: false,
      lastCompile: 0,
    };
    m.origin = { member: m.mid };
    this.byMid.set(m.mid, m);
    await this.admit(m, id, req.idBytes, req.pub, req.host, true);
    return true;
  }

  async reject(id) {
    const req = this.pending.get(id);
    if (!req) return;
    this.pending.delete(id);
    await this.sendInvite(id, req.idBytes, msg('reject', { why: 'host' }));
    this.relay.control({ t: 'kick', id });
  }

  async admit(m, id, idBytes, guestPub, hostPair = null, welcomed = false) {
    const hp = hostPair || await C.ecdhPair();
    const key = await C.pairKey(hp.priv, guestPub, this.room, guestPub, hp.pub);
    m.id = id;
    m.idBytes = idBytes;
    m.chan = new Chan(key, this.room, C.CH_PAIR, 'h2g', 'g2h');
    m.chanIn = new Chan(key, this.room, C.CH_PAIR, 'h2g', 'g2h');
    m.online = true;
    m.subs = new Set();
    m.reasm = new Reassembler();
    this.members.set(id, m);
    if (!welcomed) await this.sendInvite(id, idBytes, msg('welcome', { pub: b64u(hp.pub) }));
    this.relay.control({ t: 'admit', id });
    await this.sendTo(m, msg('admitted', {
      mid: m.mid,
      name: m.name,
      color: m.color,
      perms: m.perms,
      resume: m.resume,
      epoch: this.group.epoch,
      k: b64u(this.group.raw),
      files: this.a.files(),
      main: this.main || null,
      members: this.memberList(),
      presence: Object.fromEntries(this.presence),
    }));
    // What a newcomer needs to see straight away: the last PDF and outputs.
    for (const man of this.lastBlob.values()) await this.sendTo(m, msg('blob', man));
    this.announceMembers();
  }

  async onMember(m, h, body) {
    switch (h.t) {
      case 'sync1': {
        if (!isPath(h.path)) return;
        let d;
        try { d = await this.doc(h.path); } catch (e) {
          await this.sendTo(m, msg('nodoc', { path: h.path, why: String((e && e.message) || e) }));
          return;
        }
        m.subs.add(h.path);
        const sv = body.length ? body : null;
        let update;
        try { update = sv ? Y.encodeStateAsUpdate(d.ydoc, sv) : Y.encodeStateAsUpdate(d.ydoc); } catch (_) { update = Y.encodeStateAsUpdate(d.ydoc); }
        await this.sendTo(m, msg('sync2', {
          path: h.path, name: this.a.fileName(h.path), sv: b64u(Y.encodeStateVector(d.ydoc)),
        }, update));
        return;
      }
      case 'unsub':
        if (isPath(h.path)) m.subs.delete(h.path);
        return;
      case 'u':
        if (isPath(h.path) && body.length && body.length <= MAX_UPDATE) this.applyGuestUpdate(m, h.path, body);
        return;
      case 'p':
        this.setPresence(m.mid, cleanPresence(h.s));
        return;
      case 'compile': {
        const now = Date.now();
        if (now - m.lastCompile < 1500) return;
        m.lastCompile = now;
        if (this.a.compileRequest) this.a.compileRequest(m);
        return;
      }
      case 'rpc': {
        if (typeof h.req !== 'number' || typeof h.m !== 'string') return;
        let r, ok = true;
        try { r = await this.a.rpc(m, h.m, h.a || {}); } catch (e) { ok = false; r = String((e && e.message) || e); }
        await this.sendTo(m, msg('rpc', { req: h.req, ok, r }));
        return;
      }
      case 'need': {
        if (!Array.isArray(h.h)) return;
        await this.sendChunks((bytes) => this.sendTo(m, bytes), h.h.slice(0, 4096));
        return;
      }
      case 'bye':
        this.relay.control({ t: 'kick', id: m.id });
        this.memberGone(m, true);
        return;
      default:
    }
  }

  /* ---------- documents ---------- */

  async doc(path) {
    let d = this.docs.get(path);
    if (d) return d;
    const ydoc = await this.a.openDoc(path);
    d = this.docs.get(path);
    if (d) return d; // opened twice concurrently
    d = { ydoc, ytext: ydoc.getText('t'), um: new Map() };
    this.clientOwner.set(ydoc.clientID, 'host');
    d.onUpdate = (update) => { if (!this.ended) this.batch.add(path, update); };
    ydoc.on('update', d.onUpdate);
    this.docs.set(path, d);
    return d;
  }

  /** Is this the shared Y.Doc of `path` already (the app asks before binding)? */
  hasDoc(path) { return this.docs.has(path); }

  /** The app closed a file nobody needs any more. */
  dropDoc(path) {
    const d = this.docs.get(path);
    if (!d) return;
    d.ydoc.off('update', d.onUpdate);
    this.docs.delete(path);
  }

  applyGuestUpdate(m, path, update) {
    const d = this.docs.get(path);
    if (!d || !m.subs.has(path)) return;
    const p = m.perms;
    const deny = (why) => {
      this.sendTo(m, msg('denied', { path, why }));
      if (this.a.denied) this.a.denied(m, path, why);
    };
    // Every struct in the update must be signed with a client id that belongs
    // to THIS guest. Writing under the host's id (or another guest's) would
    // let it forge history and break everyone's copies.
    let decoded;
    try { decoded = Y.decodeUpdate(update); } catch (_) { deny('bad'); return; }
    for (const s of decoded.structs) {
      const owner = this.clientOwner.get(s.id.client);
      if (owner && owner !== m.mid) { deny('bad'); this.sendTo(m, msg('resync', { path })); return; }
    }
    for (const s of decoded.structs) if (!this.clientOwner.has(s.id.client)) this.clientOwner.set(s.id.client, m.mid);

    const full = p.python && p.latex;
    const none = !p.python && !p.latex;
    // The app's own immutable text of the file before the change (O(1)),
    // for the fast path; the full strings only when that cannot decide.
    const beforeText = !full && this.a.textOf ? this.a.textOf(path) : null;
    const beforeStr = !full && !beforeText ? d.ytext.toString() : null;
    let delta = null;
    const grab = (ev) => { delta = ev.delta; };
    if (!full) d.ytext.observe(grab);
    let um = null;
    if (!full) {
      um = d.um.get(m.mid);
      if (!um) {
        um = new Y.UndoManager(d.ytext, { trackedOrigins: new Set([m.origin]), captureTimeout: 0 });
        d.um.set(m.mid, um);
      }
    }
    try {
      Y.applyUpdate(d.ydoc, update, m.origin);
    } catch (_) { if (!full) d.ytext.unobserve(grab); deny('bad'); return; }
    if (!full) d.ytext.unobserve(grab);
    const store = d.ydoc.store;
    if (!full && (store.pendingStructs || store.pendingDs)) {
      // An update that depends on something this side never got. Applied
      // later, under whatever origin completes it, it would escape the check
      // below — so it is dropped and the guest is asked to resend from what
      // the host really has.
      store.pendingStructs = null;
      store.pendingDs = null;
      this.sendTo(m, msg('resync', { path }));
    }
    const after = d.ytext.length;
    if (after > MAX_DOC) {
      if (um) { um.undo(); um.clear(); } else { /* full rights: still capped */ }
      deny('size');
      return;
    }
    if (full) return;
    if (!delta) { um.clear(); return; } // nothing in the text changed
    let verdict;
    if (none) verdict = { ok: false, why: 'read' };
    else {
      const afterText = beforeText && this.a.textOf(path);
      const quick = beforeText && afterText && this.a.cellsOf
        ? quickVerdict(beforeText, afterText, delta, this.a.fileName(path), p, this.a.cellsOf)
        : null;
      if (quick === true) verdict = { ok: true };
      else {
        const before = beforeStr != null ? beforeStr : beforeText.toString();
        verdict = allowedChange(before, d.ytext.toString(), this.a.fileName(path), p);
      }
    }
    if (!verdict.ok) {
      um.undo();
      deny(verdict.why);
    }
    um.clear();
  }

  setPerms(mid, perms) {
    const m = this.byMid.get(mid);
    if (!m) return;
    m.perms = normPerms(perms);
    for (const d of this.docs.values()) { const um = d.um.get(mid); if (um) { um.destroy(); d.um.delete(mid); } }
    if (m.online) this.sendTo(m, msg('perms', { perms: m.perms }));
    this.announceMembers();
  }

  /** Remove someone for good: they are disconnected and the group key is
   *  replaced so they cannot read anything that follows. */
  async kick(mid) {
    const m = this.byMid.get(mid);
    if (!m) return;
    if (m.online) {
      await this.sendTo(m, msg('kicked', {}));
      this.relay.control({ t: 'kick', id: m.id });
    }
    this.memberGone(m, true);
    await this.rotateGroup(true);
  }

  memberList() {
    const list = [{ mid: 'host', name: this.name, color: COLORS[0], perms: { python: true, latex: true }, host: true, online: true }];
    for (const m of this.byMid.values()) {
      list.push({ mid: m.mid, name: m.name, color: m.color, perms: m.perms, online: m.online });
    }
    return list;
  }

  announceMembers() {
    const list = this.memberList();
    if (this.a.onMembers) this.a.onMembers(list);
    this.broadcast(msg('members', { list }));
  }

  announceFiles() {
    this.broadcast(msg('files', { files: this.a.files(), main: this.main || null }));
  }

  /* ---------- presence ---------- */

  setPresence(mid, state) {
    if (state) this.presence.set(mid, state); else this.presence.delete(mid);
    if (this.a.onPresence && mid !== 'host') this.a.onPresence(mid, state);
    this.presenceDirty.add(mid);
    if (!this.presenceTimer) {
      this.presenceTimer = setTimeout(() => {
        this.presenceTimer = 0;
        const m = {};
        for (const k of this.presenceDirty) m[k] = this.presence.get(k) || null;
        this.presenceDirty.clear();
        this.broadcast(msg('P', { m }));
      }, PRESENCE_MS);
    }
  }

  /** The host's own presence (from the app). */
  myPresence(state) { this.setPresence('host', cleanPresence(state)); }

  /* ---------- blobs: PDF, cell outputs ---------- */

  async sendChunks(send, hashes) {
    let batch = [], size = 0;
    const flush = async () => {
      if (!batch.length) return;
      const body = new Uint8Array(size);
      let o = 0;
      for (const c of batch) { body.set(c.b, o); o += c.b.length; }
      await send(msg('chunks', { h: batch.map((c) => c.h), s: batch.map((c) => c.b.length) }, body));
      batch = []; size = 0;
    };
    for (const h of hashes) {
      const b = typeof h === 'string' && this.blobs.get(h);
      if (!b) continue;
      if (size + b.length > BLOB_BATCH) await flush();
      batch.push({ h, b }); size += b.length;
    }
    await flush();
  }

  /** Publish a file to every guest: only the chunks they do not have yet
   *  travel. `kind` is 'pdf' or 'outs'; `key` tells blobs of a kind apart. */
  async publish(kind, key, bytes, meta = {}) {
    if (this.ended) return;
    const parts = await chunkify(bytes);
    const fresh = [];
    for (const p of parts) {
      this.blobs.put(p.hash, p.bytes);
      if (!this.blobSent.has(p.hash)) { this.blobSent.add(p.hash); fresh.push(p.hash); }
    }
    await this.sendChunks((b) => this.broadcast(b), fresh);
    const man = { kind, key, total: bytes.length, h: parts.map((p) => p.hash), meta };
    this.lastBlob.set(`${kind}:${key}`, man);
    await this.broadcast(msg('blob', man));
  }

  /** Compile status, mirrored on every guest's status bar. */
  compileStatus(s) { this.broadcast(msg('cs', { s })); }

  setMain(path) { this.main = path; this.announceFiles(); }

  /** End the session for everyone. */
  async end() {
    if (this.ended) return;
    try { await this.broadcast(msg('end', {})); } catch (_) { /* offline */ }
    await this.out.p;
    this.ended = true;
    this.batch.clear();
    clearTimeout(this.presenceTimer);
    for (const d of this.docs.values()) { d.ydoc.off('update', d.onUpdate); for (const um of d.um.values()) um.destroy(); }
    this.docs.clear();
    if (this.relay) { this.relay.control({ t: 'close' }); this.relay.close(); }
  }
}

/* ======================================================================
 * GUEST
 * ==================================================================== */

export class GuestSession {
  /**
   * @param {object} o
   * @param {string} o.invite
   * @param {string} o.name
   * @param {object} o.adapter
   *   onCode(code)                       safety code, while waiting for approval
   *   onAdmitted(info) · onRejected(why) · onEnd(why) · onStatus(s, detail)
   *   onFiles(files, main) · onMembers(list) · onPerms(perms)
   *   onPresence(mid, state)
   *   onDocReady(path, ydoc, name) · onNoDoc(path, why)
   *   onBlob(kind, key, bytes, meta) · onCompileStatus(s) · onDenied(path, why)
   */
  constructor(o) {
    this.o = o;
    this.a = o.adapter;
    this.name = cleanName(o.name);
    this.docs = new Map();     // path → { ydoc, ready, onUpdate }
    this.serial = new Serial();
    this.out = new Serial();
    this.batch = new Batcher((path, u) => this.send(msg('u', { path }, u)));
    this.groups = new Map();   // epoch → Chan
    this.reasmPair = new Reassembler();
    this.reasmGroup = new Reassembler();
    this.blobs = new ChunkCache(256 * 1024 * 1024);
    this.wanted = new Map();   // kind:key → manifest waiting for chunks
    this.rpcs = new Map();
    this.rpcSeq = 0;
    this.presenceTimer = 0;
    this.presenceNext = null;
    this.state = 'idle';       // idle | connecting | waiting | in | ended
    this.perms = PERM_NONE;
  }

  async start() {
    const inv = parseInvite(this.o.invite);
    this.room = inv.room;
    this.relayUrl = inv.relay;
    this.inviteKey = await C.inviteKey(inv.secret, inv.room);
    this.state = 'connecting';
    this.relay = new RelayClient({
      url: inv.relay,
      room: inv.room,
      role: 'guest',
      WebSocket: this.o.WebSocket,
      onControl: (c) => this.onControl(c),
      onBinary: (type, _from, payload) => {
        this.serial.run(() => this.onFrame(type, payload)).catch(() => {});
      },
      onStatus: (s, d) => {
        if (s === 'closed' && this.state !== 'ended') {
          const why = d || 'closed';
          this.state = 'ended';
          if (this.a.onEnd) this.a.onEnd(why === 'no-room' ? 'no-room' : why);
        }
        if (this.a.onStatus) this.a.onStatus(s, d);
      },
    });
    this.relay.connect();
  }

  async onControl(c) {
    if (c.t === 'ready') {
      // A new connection (first time or after a blip) gets a new id from the
      // relay: introduce ourselves again. With a resume token, no approval.
      this.inviteOut = new Chan(this.inviteKey, this.room, C.CH_INVITE, 'g2h', 'h2g');
      this.inviteIn = new Chan(this.inviteKey, this.room, C.CH_INVITE, 'g2h', 'h2g');
      this.pair = null;
      this.ecdh = await C.ecdhPair();
      if (!c.host) { this.hostDown = true; if (this.a.onStatus) this.a.onStatus('host-down'); return; }
      await this.sendJoin();
      return;
    }
    if (c.t === 'host') {
      this.hostDown = c.ev === 'down';
      if (this.a.onStatus) this.a.onStatus(this.hostDown ? 'host-down' : 'host-up');
      if (!this.hostDown) {
        if (!this.pair) await this.sendJoin();
        else this.resyncAll();
      }
      return;
    }
    if (c.t === 'kicked' || c.t === 'end') {
      this.finish(c.t === 'kicked' ? 'kicked' : 'end');
    }
  }

  sendJoin() {
    const join = { t: 'join', v: PROTOCOL, name: this.name, pub: b64u(this.ecdh.pub) };
    if (this.resume) join.resume = this.resume;
    else this.state = 'waiting';
    return this.out.run(async () => {
      const env = await this.inviteOut.seal(pack(join));
      this.relay.toHost(env);
    });
  }

  send(bytes) {
    return this.out.run(async () => {
      if (!this.pair || this.state === 'ended') return;
      for (const f of fragments(bytes)) this.relay.toHost(await this.pair.out.seal(f));
    });
  }

  async onFrame(type, env) {
    const h = C.peek(env);
    if (!h) return;
    let plain;
    try {
      if (h.chan === C.CH_INVITE) plain = await this.inviteIn.open(env);
      else if (h.chan === C.CH_PAIR && this.pair) plain = await this.pair.inn.open(env);
      else if (h.chan === C.CH_GROUP && type === 0x20) {
        const g = this.groups.get(h.epoch);
        if (!g) return;
        plain = await g.open(env);
      } else return;
    } catch (_) { return; }
    let parsed;
    try { parsed = unpack(plain); } catch (_) { return; }
    if (parsed.header.t === 'frag') {
      const r = h.chan === C.CH_GROUP ? this.reasmGroup : this.reasmPair;
      try { parsed = r.take(parsed.header, parsed.body); } catch (_) { parsed = null; }
      if (!parsed) return;
    }
    await this.onMessage(h.chan, parsed.header, parsed.body);
  }

  async onMessage(chan, m, body) {
    if (chan === C.CH_INVITE) {
      if (m.t === 'welcome') {
        const hostPub = fromB64u(m.pub);
        const key = await C.pairKey(this.ecdh.priv, hostPub, this.room, this.ecdh.pub, hostPub);
        this.pair = {
          out: new Chan(key, this.room, C.CH_PAIR, 'g2h', 'h2g'),
          inn: new Chan(key, this.room, C.CH_PAIR, 'g2h', 'h2g'),
        };
        if (this.a.onCode) this.a.onCode(await C.safetyCode(this.ecdh.pub, hostPub));
      } else if (m.t === 'reject') {
        this.finish(m.why === 'version' ? 'version' : 'rejected');
      }
      return;
    }
    if (chan === C.CH_PAIR) return this.onPrivate(m, body);
    return this.onGroup(m, body);
  }

  async setGroupKey(epoch, k) {
    const key = await C.groupKey(fromB64u(k), this.room, epoch);
    this.groups.set(epoch, new Chan(key, this.room, C.CH_GROUP, 'h2a', 'h2a', epoch));
    for (const e of this.groups.keys()) if (e < epoch - 1) this.groups.delete(e);
  }

  async onPrivate(m, body) {
    switch (m.t) {
      case 'admitted': {
        await this.setGroupKey(m.epoch, m.k);
        const first = !this.resume;
        this.resume = m.resume;
        this.me = { mid: String(m.mid).slice(0, 32), name: cleanName(m.name), color: /^#[0-9a-f]{3,8}$/i.test(m.color) ? m.color : '#868e96' };
        this.perms = normPerms(m.perms);
        this.state = 'in';
        if (this.a.onAdmitted) this.a.onAdmitted({ first, me: this.me, perms: this.perms, files: Array.isArray(m.files) ? m.files.filter((f) => f && isPath(f.path)) : [], main: isPath(m.main) ? m.main : null, members: cleanMembers(m.members) });
        if (m.presence && this.a.onPresence) for (const [k, v] of Object.entries(m.presence)) if (k !== this.me.mid) this.a.onPresence(k, cleanPresence(v));
        if (!first) this.resyncAll();
        if (this.presenceNext) this.flushPresence();
        return;
      }
      case 'gkey': await this.setGroupKey(m.epoch, m.k); return;
      case 'perms':
        this.perms = normPerms(m.perms);
        if (this.a.onPerms) this.a.onPerms(this.perms);
        return;
      case 'sync2': {
        const d = this.docs.get(m.path);
        if (!d) return;
        Y.applyUpdate(d.ydoc, body, ORIGIN_NET);
        // Whatever we typed that the host has not seen (offline edits).
        try {
          const mine = Y.encodeStateAsUpdate(d.ydoc, fromB64u(m.sv));
          if (Y.decodeUpdate(mine).structs.length) this.send(msg('u', { path: m.path }, mine));
        } catch (_) { /* nothing to add */ }
        if (!d.ready) {
          d.ready = true;
          if (this.a.onDocReady) this.a.onDocReady(m.path, d.ydoc, m.name);
          d.resolve(d.ydoc);
        }
        return;
      }
      case 'resync': {
        const d = this.docs.get(m.path);
        if (d) this.send(msg('sync1', { path: m.path }, Y.encodeStateVector(d.ydoc)));
        return;
      }
      case 'nodoc': {
        const d = this.docs.get(m.path);
        if (d && !d.ready) { this.docs.delete(m.path); d.reject(new Error(m.why || 'No disponible')); }
        if (this.a.onNoDoc) this.a.onNoDoc(m.path, m.why);
        return;
      }
      case 'denied':
        if (this.a.onDenied) this.a.onDenied(m.path, m.why);
        return;
      case 'rpc': {
        const r = this.rpcs.get(m.req);
        if (!r) return;
        this.rpcs.delete(m.req);
        if (m.ok) r.resolve(m.r); else r.reject(new Error(String(m.r)));
        return;
      }
      case 'chunks': this.takeChunks(m, body); return;
      case 'blob': this.takeBlob(m); return;
      case 'kicked': this.finish('kicked'); return;
      default:
    }
  }

  async onGroup(m, body) {
    switch (m.t) {
      case 'u': {
        const d = this.docs.get(m.path);
        if (d && d.ready) Y.applyUpdate(d.ydoc, body, ORIGIN_NET);
        return;
      }
      case 'P':
        if (m.m && typeof m.m === 'object' && this.a.onPresence) {
          for (const [mid, s] of Object.entries(m.m)) {
            if (this.me && mid === this.me.mid) continue;
            this.a.onPresence(mid, s ? cleanPresence(s) : null);
          }
        }
        return;
      case 'members': if (this.a.onMembers && Array.isArray(m.list)) this.a.onMembers(cleanMembers(m.list)); return;
      case 'files': if (this.a.onFiles && Array.isArray(m.files)) this.a.onFiles(m.files.filter((f) => f && isPath(f.path)), isPath(m.main) ? m.main : null); return;
      case 'chunks': this.takeChunks(m, body); return;
      case 'blob': this.takeBlob(m); return;
      case 'cs': if (this.a.onCompileStatus) this.a.onCompileStatus(m.s || {}); return;
      case 'end': this.finish('end'); return;
      default:
    }
  }

  takeChunks(m, body) {
    if (!Array.isArray(m.h) || !Array.isArray(m.s) || m.h.length !== m.s.length) return;
    let o = 0;
    for (let i = 0; i < m.h.length; i++) {
      const n = m.s[i];
      if (!(n > 0) || o + n > body.length) return;
      this.blobs.put(String(m.h[i]), body.subarray(o, o + n));
      o += n;
    }
    for (const man of [...this.wanted.values()]) this.tryBlob(man);
  }

  takeBlob(man) {
    if (!man || !Array.isArray(man.h) || !(man.total >= 0) || man.total > 512 * 1024 * 1024) return;
    const id = `${man.kind}:${man.key}`;
    this.wanted.set(id, man); // a newer manifest of the same blob replaces the older
    if (!this.tryBlob(man)) {
      const miss = this.blobs.missing(man.h);
      if (miss.length) this.send(msg('need', { h: miss }));
    }
  }

  tryBlob(man) {
    const id = `${man.kind}:${man.key}`;
    if (this.wanted.get(id) !== man) return true;
    const bytes = this.blobs.assemble(man.h, man.total);
    if (!bytes) return false;
    this.wanted.delete(id);
    if (this.a.onBlob) this.a.onBlob(man.kind, man.key, bytes, man.meta || {});
    return true;
  }

  /* ---------- the app's side ---------- */

  /** Open a project file: resolves with its Y.Doc once it holds the text. */
  openDoc(path) {
    const had = this.docs.get(path);
    if (had) return had.promise;
    const ydoc = new Y.Doc();
    const d = { ydoc, ready: false };
    d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
    d.onUpdate = (u, origin) => { if (origin !== ORIGIN_NET) this.batch.add(path, u); };
    ydoc.on('update', d.onUpdate);
    this.docs.set(path, d);
    this.send(msg('sync1', { path }));
    return d.promise;
  }

  closeDoc(path) {
    const d = this.docs.get(path);
    if (!d) return;
    this.docs.delete(path);
    d.ydoc.off('update', d.onUpdate);
    d.ydoc.destroy();
    this.send(msg('unsub', { path }));
  }

  resyncAll() {
    for (const [path, d] of this.docs) this.send(msg('sync1', { path }, Y.encodeStateVector(d.ydoc)));
    if (this.lastPresence) this.send(msg('p', { s: this.lastPresence }));
  }

  /** Where I am; sent at most ~30 times per second, always the latest. */
  setPresence(state) {
    this.presenceNext = state;
    if (this.presenceTimer) return;
    this.flushPresence();
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = 0;
      if (this.presenceNext) this.flushPresence();
    }, PRESENCE_MS);
  }

  flushPresence() {
    if (this.state !== 'in') return;
    const s = this.presenceNext;
    this.presenceNext = null;
    this.lastPresence = s;
    this.send(msg('p', { s }));
  }

  requestCompile() { return this.send(msg('compile', {})); }

  rpc(method, args, timeout = 15000) {
    const req = ++this.rpcSeq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.rpcs.delete(req); reject(new Error('El anfitrión no respondió.')); }, timeout);
      this.rpcs.set(req, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.send(msg('rpc', { req, m: method, a: args }));
    });
  }

  finish(why) {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.batch.clear();
    clearTimeout(this.presenceTimer);
    for (const r of this.rpcs.values()) r.reject(new Error('La sesión terminó.'));
    this.rpcs.clear();
    if (this.relay) this.relay.close();
    if (this.a.onEnd) this.a.onEnd(why);
  }

  async leave() {
    if (this.state === 'ended') return;
    try { await this.send(msg('bye', {})); } catch (_) { /* offline */ }
    await this.out.p;
    this.finish('left');
  }
}

