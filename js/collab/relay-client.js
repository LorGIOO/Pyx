// WebSocket connection to the relay, with automatic reconnection.
//
// Only OUTGOING connections: a session never makes this machine listen on a
// port. Frames are routed by their first byte (see server/relay.mjs); what
// follows is an encrypted envelope this module never looks into.

const FATAL = new Set(['token', 'no-room', 'kicked', 'end', 'full']);

export class RelayClient {
  /**
   * @param {object} o
   * @param {string} o.url      wss://… of the relay
   * @param {string} o.room
   * @param {'host'|'guest'} o.role
   * @param {string} [o.token]  host only
   * @param {(ctl: object) => void} o.onControl
   * @param {(type: number, from: Uint8Array|null, payload: Uint8Array) => void} o.onBinary
   * @param {(status: string, detail?: string) => void} [o.onStatus]
   */
  constructor(o) {
    this.o = o;
    this.ws = null;
    this.closed = false;
    this.tries = 0;
    this.timer = 0;
    this.status = 'idle';
    this.fatal = null;
  }

  setStatus(s, detail) {
    this.status = s;
    if (this.o.onStatus) this.o.onStatus(s, detail);
  }

  connect() {
    if (this.closed) return;
    const WS = this.o.WebSocket || globalThis.WebSocket;
    if (!WS) { this.setStatus('closed', 'Este entorno no tiene WebSocket.'); return; }
    this.setStatus(this.tries ? 'reconnecting' : 'connecting');
    let ws;
    try { ws = new WS(this.o.url); } catch (e) { this.retry(); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      const hello = { t: 'hello', role: this.o.role, room: this.o.room };
      if (this.o.role === 'host') hello.token = this.o.token;
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let c;
        try { c = JSON.parse(ev.data); } catch (_) { return; }
        if (c.t === 'ready') { this.tries = 0; this.setStatus('open'); }
        if (c.t === 'error' && FATAL.has(c.code)) this.fatal = c.code;
        if (c.t === 'kicked' || c.t === 'end') this.fatal = c.t;
        this.o.onControl(c);
        return;
      }
      const b = new Uint8Array(ev.data);
      if (!b.length) return;
      if (b[0] === 0x10 && b.length > 9) this.o.onBinary(0x10, b.subarray(1, 9), b.subarray(9));
      else this.o.onBinary(b[0], null, b.subarray(1));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed || this.fatal) { this.closed = true; this.setStatus('closed', this.fatal || ''); return; }
      this.retry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  retry() {
    if (this.closed) return;
    this.tries++;
    const wait = Math.min(15_000, 400 * 2 ** Math.min(this.tries, 6)) * (0.75 + Math.random() * 0.5);
    this.setStatus('reconnecting');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), wait);
  }

  get open() { return !!this.ws && this.ws.readyState === 1 && this.status === 'open'; }
  get buffered() { return this.ws ? this.ws.bufferedAmount : 0; }

  sendRaw(bytes) {
    if (!this.open) return false;
    this.ws.send(bytes);
    return true;
  }

  /** guest → host */
  toHost(payload) {
    const f = new Uint8Array(1 + payload.length);
    f[0] = 0x10; f.set(payload, 1);
    return this.sendRaw(f);
  }

  /** host → every admitted guest */
  broadcast(payload) {
    const f = new Uint8Array(1 + payload.length);
    f[0] = 0x20; f.set(payload, 1);
    return this.sendRaw(f);
  }

  /** host → one guest (8-byte id) */
  sendTo(idBytes, payload) {
    const f = new Uint8Array(9 + payload.length);
    f[0] = 0x21; f.set(idBytes, 1); f.set(payload, 9);
    return this.sendRaw(f);
  }

  control(obj) {
    if (!this.open) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    if (this.ws) { try { this.ws.close(1000, 'bye'); } catch (_) { /* gone */ } }
    this.ws = null;
    this.setStatus('closed');
  }
}
