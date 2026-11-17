// Pyx relay — the only server a shared session needs.
//
// It forwards encrypted bytes between ONE host and its guests, per room, and
// that is all it can do: it holds no key (the secret travels in the invite
// code and never reaches it), so it can neither read nor forge what passes.
// No machine taking part in a session opens a port: the host and the guests
// all connect OUT to this relay, like a browser to a web site.
//
// Routing (binary frames, first byte):
//   guest → relay  0x10 payload            → host gets 0x10 <guest id: 8 bytes> payload
//   host  → relay  0x20 payload            → every ADMITTED guest gets 0x20 payload
//   host  → relay  0x21 <guest id> payload → that guest gets 0x21 payload
// Guests never reach each other directly: whatever one says goes to the host,
// which checks it (permissions) before passing it on.
//
// Control (text frames, JSON):
//   hello {role:'host', room, token} | {role:'guest', room}
//   host → relay: admit {id} · kick {id} · close
//   relay → host: ready · peer {ev:'join'|'leave', id}
//   relay → guest: ready {id, host} · host {ev:'up'|'down'} · kicked · end · error {code}
//
// Abuse limits: frame size, bytes per second per connection (token bucket),
// guests per room, connections per address, rooms per server, a short leash
// for guests nobody has admitted yet, heartbeats, and rooms that disappear a
// while after their host leaves.

import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const ROOM_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;

export const DEFAULTS = {
  port: 8787,
  host: '0.0.0.0',
  maxPayload: 2 * 1024 * 1024,     // one frame (PDF chunks are ≤ 256 KB)
  maxGuests: 32,                   // per room
  maxRooms: 5000,
  maxConnPerIp: 64,
  hostRate: 24 * 1024 * 1024,      // bytes/s a host may push (PDFs to everyone)
  hostBurst: 96 * 1024 * 1024,
  guestRate: 4 * 1024 * 1024,
  guestBurst: 16 * 1024 * 1024,
  pendingFrames: 6,                // frames a not-yet-admitted guest may send
  pendingBytes: 64 * 1024,
  helloMs: 10_000,
  pingMs: 20_000,
  hostGraceMs: 10 * 60_000,        // a room survives its host this long
  trustProxy: false,               // read X-Forwarded-For (behind Caddy/nginx)
};

const sha = (s) => createHash('sha256').update(s).digest();

class Bucket {
  constructor(rate, burst) { this.rate = rate; this.burst = burst; this.tokens = burst; this.at = Date.now(); }
  take(n) {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

export function createRelay(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const log = o.log || ((...a) => console.log(new Date().toISOString(), ...a));
  const rooms = new Map(); // room -> { tokenHash, host, guests: Map<id, {ws, admitted, frames, bytes}>, goneAt }
  const perIp = new Map();

  const http = o.tlsCert && o.tlsKey
    ? createHttps({ cert: readFileSync(o.tlsCert), key: readFileSync(o.tlsKey) })
    : createHttp();
  http.on('request', (req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    // Optional: serve something else on the same port (a test page of the
    // app, see server/try.mjs). The relay itself needs nothing but /health.
    if (o.onRequest) { o.onRequest(req, res); return; }
    res.writeHead(404); res.end();
  });

  const wss = new WebSocketServer({ server: http, maxPayload: o.maxPayload, perMessageDeflate: false });

  const sendJson = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const sendBin = (ws, ...parts) => {
    if (!ws || ws.readyState !== 1) return;
    // Back-pressure: a guest that cannot keep up is dropped rather than
    // letting the relay buffer without bound.
    if (ws.bufferedAmount > 64 * 1024 * 1024) { ws.terminate(); return; }
    ws.send(Buffer.concat(parts), { binary: true });
  };

  function dropRoom(id, why) {
    const r = rooms.get(id);
    if (!r) return;
    for (const g of r.guests.values()) { sendJson(g.ws, { t: 'end', why }); g.ws.close(1000, 'end'); }
    if (r.host) r.host.close(1000, 'end');
    rooms.delete(id);
  }

  wss.on('connection', (ws, req) => {
    const ip = (o.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())
      || req.socket.remoteAddress || '?';
    const n = (perIp.get(ip) || 0) + 1;
    if (n > o.maxConnPerIp) { ws.close(1008, 'too many'); return; }
    perIp.set(ip, n);

    const me = { role: null, room: null, id: null, idBuf: null, bucket: null, alive: true };
    ws.on('pong', () => { me.alive = true; });
    const helloTimer = setTimeout(() => { if (!me.role) ws.close(1008, 'hello'); }, o.helloMs);

    // Nothing a client sends may bring the relay down: whatever goes wrong
    // while handling one frame costs that connection, not the server.
    ws.on('message', (data, isBinary) => {
      try {
        onMessage(data, isBinary);
      } catch (e) {
        log('error en un mensaje:', (e && e.message) || e);
        try { ws.close(1011, 'error'); } catch (_) { /* already gone */ }
      }
    });
    const onMessage = (data, isBinary) => {
      if (!me.role) {
        if (isBinary) { ws.close(1008, 'hello'); return; }
        let h;
        try { h = JSON.parse(String(data)); } catch (_) { ws.close(1008, 'hello'); return; }
        if (!h || h.t !== 'hello' || !ROOM_RE.test(String(h.room || ''))) { ws.close(1008, 'hello'); return; }
        clearTimeout(helloTimer);
        if (h.role === 'host') {
          if (!TOKEN_RE.test(String(h.token || ''))) { ws.close(1008, 'token'); return; }
          let r = rooms.get(h.room);
          const th = sha(h.token);
          if (!r) {
            if (rooms.size >= o.maxRooms) { sendJson(ws, { t: 'error', code: 'full' }); ws.close(1013, 'full'); return; }
            r = { tokenHash: th, host: null, guests: new Map(), goneAt: 0 };
            rooms.set(h.room, r);
          } else if (!timingSafeEqual(r.tokenHash, th)) {
            sendJson(ws, { t: 'error', code: 'token' }); ws.close(1008, 'token'); return;
          }
          if (r.host && r.host !== ws) r.host.close(4000, 'replaced'); // the same host reconnecting
          r.host = ws;
          r.goneAt = 0;
          me.role = 'host'; me.room = h.room;
          me.bucket = new Bucket(o.hostRate, o.hostBurst);
          sendJson(ws, { t: 'ready', guests: [...r.guests.entries()].map(([id, g]) => ({ id, admitted: g.admitted })) });
          for (const g of r.guests.values()) sendJson(g.ws, { t: 'host', ev: 'up' });
          return;
        }
        if (h.role === 'guest') {
          const r = rooms.get(h.room);
          if (!r) { sendJson(ws, { t: 'error', code: 'no-room' }); ws.close(1000, 'no-room'); return; }
          if (r.guests.size >= o.maxGuests) { sendJson(ws, { t: 'error', code: 'full' }); ws.close(1013, 'full'); return; }
          const idBuf = randomBytes(8);
          me.role = 'guest'; me.room = h.room; me.idBuf = idBuf; me.id = idBuf.toString('hex');
          me.bucket = new Bucket(o.guestRate, o.guestBurst);
          r.guests.set(me.id, { ws, admitted: false, frames: 0, bytes: 0 });
          sendJson(ws, { t: 'ready', id: me.id, host: !!r.host });
          sendJson(r.host, { t: 'peer', ev: 'join', id: me.id });
          return;
        }
        ws.close(1008, 'role');
        return;
      }

      const r = rooms.get(me.room);
      if (!r) { ws.close(1000, 'end'); return; }
      const size = data.length || 0;
      if (!me.bucket.take(size)) { ws.close(1008, 'rate'); return; }

      if (me.role === 'host') {
        if (!isBinary) {
          let c;
          try { c = JSON.parse(String(data)); } catch (_) { return; }
          // Anything that is not an object (`null`, a number, a string) is
          // ignored: reading `.t` of it threw, and an exception in this
          // handler took the whole relay — every session — down with it.
          if (!c || typeof c !== 'object') return;
          const g = typeof c.id === 'string' ? r.guests.get(c.id) : null;
          if (c.t === 'admit' && g) g.admitted = true;
          else if (c.t === 'kick' && g) { sendJson(g.ws, { t: 'kicked' }); g.ws.close(1000, 'kicked'); }
          else if (c.t === 'close') dropRoom(me.room, 'host');
          return;
        }
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf[0] === 0x20) {
          const payload = buf.subarray(1);
          for (const g of r.guests.values()) if (g.admitted) sendBin(g.ws, Buffer.from([0x20]), payload);
        } else if (buf[0] === 0x21 && buf.length > 9) {
          const g = r.guests.get(buf.subarray(1, 9).toString('hex'));
          if (g) sendBin(g.ws, Buffer.from([0x21]), buf.subarray(9));
        }
        return;
      }

      // guest
      if (!isBinary) return;
      const g = r.guests.get(me.id);
      if (!g) return;
      if (!g.admitted) {
        g.frames++; g.bytes += size;
        if (g.frames > o.pendingFrames || g.bytes > o.pendingBytes) { ws.close(1008, 'pending'); return; }
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf[0] !== 0x10 || !r.host) return;
      sendBin(r.host, Buffer.from([0x10]), me.idBuf, buf.subarray(1));
    };

    ws.on('close', () => {
      clearTimeout(helloTimer);
      const left = (perIp.get(ip) || 1) - 1;
      if (left <= 0) perIp.delete(ip); else perIp.set(ip, left);
      const r = me.room && rooms.get(me.room);
      if (!r) return;
      if (me.role === 'host' && r.host === ws) {
        r.host = null;
        r.goneAt = Date.now();
        for (const g of r.guests.values()) sendJson(g.ws, { t: 'host', ev: 'down' });
      } else if (me.role === 'guest' && r.guests.get(me.id)?.ws === ws) {
        r.guests.delete(me.id);
        sendJson(r.host, { t: 'peer', ev: 'leave', id: me.id });
      }
    });
    ws.on('error', () => {});
    ws.__pyx = me;
  });

  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      const me = ws.__pyx;
      if (me && !me.alive) { ws.terminate(); continue; }
      if (me) me.alive = false;
      try { ws.ping(); } catch (_) { /* closing */ }
    }
    const now = Date.now();
    for (const [id, r] of rooms) {
      if (!r.host && r.goneAt && now - r.goneAt > o.hostGraceMs) dropRoom(id, 'host-gone');
    }
  }, o.pingMs);

  return {
    http,
    wss,
    rooms,
    listen() {
      return new Promise((resolve) => http.listen(o.port, o.host, () => resolve(http.address())));
    },
    close() {
      clearInterval(beat);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => { wss.close(() => http.close(() => resolve())); });
    },
    log,
  };
}

// `node server/relay.mjs` — configuration through the environment.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('relay.mjs')) {
  const relay = createRelay({
    port: +(process.env.PORT || DEFAULTS.port),
    host: process.env.HOST || DEFAULTS.host,
    tlsCert: process.env.TLS_CERT,
    tlsKey: process.env.TLS_KEY,
    trustProxy: process.env.TRUST_PROXY === '1',
  });
  relay.listen().then((a) => relay.log(`Relé de Pyx escuchando en ${a.address}:${a.port}`));
  const stop = () => relay.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
