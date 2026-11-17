// End to end: a real relay (server/relay.mjs) on a local port, one host and
// several guests talking the real encrypted protocol. Only the app is
// replaced: documents are plain Y.Docs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as Y from 'yjs';
import { createRelay } from '../server/relay.mjs';
import { HostSession, GuestSession } from '../js/collab/session.js';
import { parseInvite, makeInvite } from '../js/collab/wire.js';
import { randomBytes } from '../js/collab/bytes.js';

const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  '%#python id=a1',
  'x = 2',
  '%#end',
  'El valor es \\py{x}.',
  '\\end{document}',
  '',
].join('\n');

const until = async (fn, ms = 4000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let relay, url;
beforeAll(async () => {
  relay = createRelay({ port: 0, host: '127.0.0.1', log: () => {}, pingMs: 60_000 });
  const a = await relay.listen();
  url = `ws://127.0.0.1:${a.port}`;
});
afterAll(() => relay.close());

function makeHost(files = { 'main.pltx': DOC }) {
  const docs = new Map();
  const events = { joins: [], denied: [], presence: new Map(), compiles: 0, members: [] };
  const host = new HostSession({
    relay: url,
    name: 'Ana',
    adapter: {
      async openDoc(path) {
        if (!(path in files)) throw new Error('no existe');
        if (!docs.has(path)) {
          const d = new Y.Doc();
          d.getText('t').insert(0, files[path]);
          docs.set(path, d);
        }
        return docs.get(path);
      },
      fileName: (p) => p,
      files: () => Object.keys(files).map((path) => ({ path })),
      joinRequest: (r) => events.joins.push(r),
      onMembers: (l) => { events.members = l; },
      onPresence: (mid, s) => events.presence.set(mid, s),
      compileRequest: () => { events.compiles++; },
      rpc: async (_m, method, args) => ({ method, args }),
      denied: (m, path, why) => events.denied.push({ who: m.name, path, why }),
    },
  });
  return { host, docs, events };
}

function makeGuest(invite, name) {
  const ev = { code: null, admitted: null, ended: null, denied: [], blobs: [], presence: new Map(), docs: new Map(), cs: [] };
  const g = new GuestSession({
    invite,
    name,
    adapter: {
      onCode: (c) => { ev.code = c; },
      onAdmitted: (i) => { ev.admitted = i; },
      onRejected: () => {},
      onEnd: (why) => { ev.ended = why; },
      onPresence: (mid, s) => ev.presence.set(mid, s),
      onDocReady: (p, d) => ev.docs.set(p, d),
      onBlob: (kind, key, bytes) => ev.blobs.push({ kind, key, bytes }),
      onDenied: (path, why) => ev.denied.push({ path, why }),
      onCompileStatus: (s) => ev.cs.push(s),
    },
  });
  return { g, ev };
}

async function join(h, invite, name, perms) {
  const n = h.events.joins.length;
  const guest = makeGuest(invite, name);
  await guest.g.start();
  const req = await until(() => h.events.joins[n]);
  expect(req.name).toBe(name);
  await h.host.approve(req.id, perms);
  await until(() => guest.ev.admitted);
  guest.req = req;
  return guest;
}

const text = (d) => d.getText('t').toString();
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

describe('collab · sesión de extremo a extremo con el relé', () => {
  it('unirse, aprobar, editar a la vez y converger', async () => {
    const h = makeHost();
    const invite = await h.host.start();
    await until(() => h.host.status === 'open');

    const bea = await join(h, invite, 'Bea', { python: true, latex: true });
    expect(bea.ev.code).toBe(bea.req.code); // the same safety code on both screens
    expect(bea.ev.admitted.files.map((f) => f.path)).toEqual(['main.pltx']);

    const doc = await bea.g.openDoc('main.pltx');
    expect(text(doc)).toBe(DOC);

    const carl = await join(h, invite, 'Carl', { python: true, latex: true });
    const doc2 = await carl.g.openDoc('main.pltx');

    // Three people type at the same time in different places.
    const hostDoc = h.docs.get('main.pltx');
    hostDoc.getText('t').insert(0, '% host\n');
    doc.getText('t').insert(doc.getText('t').length, '% bea\n');
    doc2.getText('t').insert(text(doc2).indexOf('El valor'), 'Carl dice: ');
    await until(() => text(hostDoc) === text(doc) && text(doc) === text(doc2) && text(doc).includes('Carl dice') && text(doc).includes('% bea') && text(doc).startsWith('% host'));

    await h.host.end();
    await until(() => bea.ev.ended && carl.ev.ended);
  });

  it('quien solo tiene LaTeX no puede tocar Python: el anfitrión lo deshace para todos', async () => {
    const h = makeHost();
    const invite = await h.host.start();
    const lat = await join(h, invite, 'Lucía', { python: false, latex: true });
    const obs = await join(h, invite, 'Olga', { python: true, latex: true });
    const d = await lat.g.openDoc('main.pltx');
    const o = await obs.g.openDoc('main.pltx');
    const hostDoc = h.docs.get('main.pltx');

    // Allowed: prose.
    d.getText('t').insert(text(d).indexOf('El valor'), 'Hola. ');
    await until(() => text(hostDoc).includes('Hola. ') && text(o).includes('Hola. '));

    // Not allowed: code in the cell, a brand new cell, a \py{}.
    const at = text(d).indexOf('x = 2');
    d.getText('t').insert(at, 'import os; os.system("rm -rf ~")\n');
    await until(() => lat.ev.denied.length === 1);
    await until(() => !text(d).includes('os.system'));
    expect(text(hostDoc)).not.toContain('os.system');
    expect(text(o)).not.toContain('os.system');
    expect(h.events.denied[0]).toMatchObject({ who: 'Lucía', why: 'python' });

    d.getText('t').insert(text(d).indexOf('\\end{document}'), '%#python\nimport os\n%#end\n');
    d.getText('t').insert(0, '\\py{__import__("os").getcwd()}');
    await until(() => lat.ev.denied.length >= 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(text(hostDoc)).not.toContain('import os');
    expect(text(hostDoc)).not.toContain('__import__');
    expect(text(d)).toBe(text(hostDoc));
    expect(text(o)).toBe(text(hostDoc));
    await h.host.end();
  });

  it('solo lectura: nada de lo que envía se aplica', async () => {
    const h = makeHost();
    const invite = await h.host.start();
    const r = await join(h, invite, 'Rita', { python: false, latex: false });
    const d = await r.g.openDoc('main.pltx');
    d.getText('t').insert(0, 'VANDALISMO ');
    await until(() => r.ev.denied.length > 0);
    await until(() => !text(d).includes('VANDALISMO'));
    expect(text(h.docs.get('main.pltx'))).toBe(DOC);
    await h.host.end();
  });

  it('cambiar permisos en directo', async () => {
    const h = makeHost();
    const invite = await h.host.start();
    const p = await join(h, invite, 'Pablo', { python: false, latex: true });
    const d = await p.g.openDoc('main.pltx');
    h.host.setPerms(h.events.members.find((m) => m.name === 'Pablo').mid, { python: true, latex: true });
    await new Promise((r) => setTimeout(r, 50));
    d.getText('t').insert(text(d).indexOf('x = 2'), 'y = 3\n');
    await until(() => text(h.docs.get('main.pltx')).includes('y = 3'));
    await h.host.end();
  });

  it('un invitado no puede firmar cambios con el id de otro', async () => {
    const h = makeHost();
    const invite = await h.host.start();
    const m = await join(h, invite, 'Mallory', { python: true, latex: true });
    const d = await m.g.openDoc('main.pltx');
    // A forged update: items written under the HOST's client id, continuing
    // its clock (so Yjs would take them as the host's own next edit).
    const H = h.docs.get('main.pltx').clientID;
    const forged = new Y.Doc();
    forged.clientID = H;
    forged.getText('t').insert(0, 'x'.repeat(DOC.length)); // clocks 0..N-1, like the host's
    forged.getText('t').insert(DOC.length, 'FORJADO ');
    const upd = Y.encodeStateAsUpdate(forged, Y.encodeStateVector(d));
    expect(Y.decodeUpdate(upd).structs.every((st) => st.id.client === H)).toBe(true);
    Y.applyUpdate(d, upd); // Mallory's doc relays it to the host
    await until(() => m.ev.denied.length > 0);
    expect(text(h.docs.get('main.pltx'))).not.toContain('FORJADO');
    await h.host.end();
  });

  it('presencia: el ratón y la selección llegan limpios a los demás', async () => {
    const h = makeHost();
    const invite = await h.host.start();
    const a = await join(h, invite, 'A', { python: true, latex: true });
    const b = await join(h, invite, 'B', { python: true, latex: true });
    a.g.setPresence({ f: 'main.pltx', p: { z: 'pdf', pg: 2, x: 100, y: 200 }, evil: '<script>', s: ['AAAA', 'BBBB'] });
    const midA = a.ev.admitted.me.mid;
    const got = await until(() => b.ev.presence.get(midA));
    expect(got).toEqual({ f: 'main.pltx', s: ['AAAA', 'BBBB'], p: { z: 'pdf', pg: 2, x: 100, y: 200 }, t: null, pg: null });
    expect(h.events.presence.get(midA).p.pg).toBe(2);
    h.host.myPresence({ f: 'main.pltx', p: { z: 'ui', a: 'ribbon' } });
    await until(() => a.ev.presence.get('host') && b.ev.presence.get('host'));
    await h.host.end();
  });

  it('expulsar: se desconecta, cambia la clave y el resto sigue', async () => {
    const h = makeHost();
    const invite = await h.host.start();
    const k = await join(h, invite, 'Kim', { python: true, latex: true });
    const s = await join(h, invite, 'Sol', { python: true, latex: true });
    const ds = await s.g.openDoc('main.pltx');
    const epoch = h.host.group.epoch;
    await h.host.kick(k.ev.admitted.me.mid);
    await until(() => k.ev.ended === 'kicked');
    expect(h.host.group.epoch).toBe(epoch + 1);
    h.docs.get('main.pltx').getText('t').insert(0, 'tras la expulsión ');
    await until(() => text(ds).startsWith('tras la expulsión'));
    await h.host.end();
  });

  it('el PDF llega entero y la segunda vez solo viaja lo que cambió', async () => {
    const h = makeHost();
    const invite = await h.host.start();
    const g = await join(h, invite, 'Gus', { python: false, latex: true });
    const pdf = randomBytes(1_200_000);
    let sent = 0;
    const orig = h.host.relay.broadcast.bind(h.host.relay);
    h.host.relay.broadcast = (b) => { sent += b.length; return orig(b); };
    await h.host.publish('pdf', 'main', pdf, { gen: 1 });
    await until(() => g.ev.blobs.length === 1);
    expect(same(g.ev.blobs[0].bytes, pdf)).toBe(true);
    const first = sent;
    sent = 0;
    const pdf2 = pdf.slice();
    pdf2.set(randomBytes(500), 600_000); // one region changes
    await h.host.publish('pdf', 'main', pdf2, { gen: 2 });
    await until(() => g.ev.blobs.length === 2);
    expect(same(g.ev.blobs[1].bytes, pdf2)).toBe(true);
    expect(sent).toBeLessThan(first * 0.25);
    // A late joiner asks for what it lacks and gets the latest PDF.
    const late = await join(h, invite, 'Tardío', { python: false, latex: false });
    await until(() => late.ev.blobs.length === 1);
    expect(same(late.ev.blobs[0].bytes, pdf2)).toBe(true);
    await h.host.end();
  });

  it('peticiones al anfitrión: compilar y RPC', async () => {
    const h = makeHost();
    const invite = await h.host.start();
    const g = await join(h, invite, 'Rui', { python: true, latex: true });
    g.g.requestCompile();
    await until(() => h.events.compiles === 1);
    const r = await g.g.rpc('synctexEdit', { page: 1 });
    expect(r).toEqual({ method: 'synctexEdit', args: { page: 1 } });
    h.host.compileStatus({ compiling: true });
    await until(() => g.ev.cs.length === 1);
    await h.host.end();
  });

  it('sin el secreto de la invitación nadie llega a pedir paso', async () => {
    const h = makeHost();
    const invite = await h.host.start();
    const { relay: r, room } = parseInvite(invite);
    const fake = makeInvite(r, room, randomBytes(32)); // right room, wrong secret
    const intruder = makeGuest(fake, 'Intruso');
    await intruder.g.start();
    await new Promise((res) => setTimeout(res, 300));
    expect(h.events.joins).toHaveLength(0);
    expect(intruder.ev.admitted).toBeNull();
    intruder.g.finish('test');
    await h.host.end();
  });

  it('un corte de red no pierde nada ni pide aprobar otra vez', async () => {
    const h = makeHost();
    const invite = await h.host.start();
    const n = await join(h, invite, 'Nora', { python: true, latex: true });
    const d = await n.g.openDoc('main.pltx');
    const hostDoc = h.docs.get('main.pltx');
    n.g.relay.ws.close(); // the Wi-Fi drops
    await until(() => n.g.relay.status === 'reconnecting');
    d.getText('t').insert(0, '% escrito sin conexión\n');      // she keeps typing
    hostDoc.getText('t').insert(hostDoc.getText('t').length, '% mientras tanto\n');
    await until(() => text(hostDoc).includes('sin conexión') && text(d).includes('mientras tanto'), 8000);
    expect(text(d)).toBe(text(hostDoc));
    expect(h.events.joins).toHaveLength(1); // no second approval
    await h.host.end();
  }, 15000);

  // The relay only notices a dead connection at its next heartbeat. Until
  // then the host still believes the guest is connected — and the guest,
  // already back on a new connection, was treated as a stranger.
  it('quien vuelve antes de que se note su desconexión no pide paso otra vez ni sale dos veces', async () => {
    const h = makeHost();
    const invite = await h.host.start();
    const n = await join(h, invite, 'Nora', { python: true, latex: true });
    const d = await n.g.openDoc('main.pltx');
    const hostDoc = h.docs.get('main.pltx');
    // The host never hears that the old connection went away.
    const real = h.host.onControl.bind(h.host);
    h.host.onControl = (c) => { if (!(c.t === 'peer' && c.ev === 'leave')) real(c); };
    n.g.relay.ws.close();
    d.getText('t').insert(0, '% de vuelta\n');
    await until(() => text(hostDoc).includes('de vuelta'), 8000);
    expect(h.events.joins).toHaveLength(1);
    expect(h.events.members.filter((m) => m.name === 'Nora')).toHaveLength(1);
    expect(h.events.members.find((m) => m.name === 'Nora').online).toBe(true);
    // And she still receives what the host writes.
    hostDoc.getText('t').insert(0, '% hola\n');
    await until(() => text(d).includes('hola'));
    expect(text(d)).toBe(text(hostDoc));
    await h.host.end();
  }, 15000);

  it('un texto no crece sin límite ni siquiera con todos los permisos', async () => {
    const h = makeHost();
    const invite = await h.host.start();
    const g = await join(h, invite, 'Gus', { python: true, latex: true });
    const d = await g.g.openDoc('main.pltx');
    const hostDoc = h.docs.get('main.pltx');
    // Pretend the shared text is already near the cap (32 MB) without
    // building one: the host measures the text it holds.
    const yt = hostDoc.getText('t');
    Object.defineProperty(yt, 'length', { get: () => 32 * 1024 * 1024 - 10, configurable: true });
    d.getText('t').insert(0, 'x'.repeat(200));
    await until(() => g.ev.denied.some((x) => x.why === 'size'));
    delete yt.length;
    expect(text(hostDoc)).toBe(DOC);
    await h.host.end();
  });

  it('rechazar una petición', async () => {
    const h = makeHost();
    const invite = await h.host.start();
    const x = makeGuest(invite, 'X');
    await x.g.start();
    const req = await until(() => h.events.joins[0]);
    await h.host.reject(req.id);
    await until(() => x.ev.ended);
    expect(x.ev.admitted).toBeNull();
    await h.host.end();
  });
});

describe('collab · documentos grandes', () => {
  it('un documento de varios megas llega entero (en fragmentos) y se edita', async () => {
    const big = Array.from({ length: 30000 }, (_, i) => `Párrafo ${i} con acentos áéíóú y texto de relleno.`).join('\n');
    const h = makeHost({ 'grande.tex': big });
    const invite = await h.host.start();
    const g = await join(h, invite, 'Gema', { python: false, latex: true });
    const t0 = Date.now();
    const d = await g.g.openDoc('grande.tex');
    expect(text(d).length).toBe(big.length);
    expect(Date.now() - t0).toBeLessThan(5000);
    d.getText('t').insert(10, 'X');
    await until(() => text(h.docs.get('grande.tex')).startsWith('Párrafo 0 X'));
    await h.host.end();
  }, 20000);
});

describe('collab · el relé aguanta lo que le echen', () => {
  const open = (u) => new Promise((resolve, reject) => {
    const ws = new WebSocket(u);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => resolve(ws);
    ws.onerror = reject;
  });
  const room = 'sala-de-prueba-0123456789';
  const token = 't'.repeat(43);

  it('ningún mensaje de un cliente lo tumba', async () => {
    const hostWs = await open(url);
    hostWs.send(JSON.stringify({ t: 'hello', role: 'host', room, token }));
    await new Promise((r) => { hostWs.onmessage = r; });
    // Orders that are not objects: `null` used to throw inside the relay and
    // take the whole process — every session of every user — down.
    for (const bad of ['null', '0', '"x"', '[]', '{', 'true', '{"t":"kick","id":null}', '{"t":"admit","id":{}}']) hostWs.send(bad);
    hostWs.send(new Uint8Array([0x21, 1, 2]));           // a truncated address
    hostWs.send(new Uint8Array(0));                       // an empty frame
    hostWs.send(new Uint8Array([0x99, 1, 2, 3]));         // an unknown type
    await new Promise((r) => setTimeout(r, 150));
    // Still serving: a new session works end to end.
    const h = makeHost();
    const invite = await h.host.start();
    const g = await join(h, invite, 'Zoe', { python: true, latex: true });
    expect(text(await g.g.openDoc('main.pltx'))).toBe(DOC);
    await h.host.end();
    hostWs.close();
  });

  it('un invitado no puede hacer que el anfitrión acumule un mensaje sin fin', async () => {
    const h = makeHost();
    const invite = await h.host.start();
    const g = await join(h, invite, 'Mal', { python: true, latex: true });
    await g.g.openDoc('main.pltx');
    const m = [...h.host.members.values()][0];
    // 300 fragments announced (75 MB): refused at the first one.
    const { pack } = await import('../js/collab/wire.js');
    await g.g.out.run(async () => {
      for (let i = 0; i < 3; i++) g.g.relay.toHost(await g.g.pair.out.seal(pack({ t: 'frag', id: 7, i, n: 300 }, new Uint8Array(1000))));
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(m.reasm.cur).toBeNull();
    // …and a legitimate edit still goes through afterwards.
    const d = await g.g.openDoc('main.pltx');
    d.getText('t').insert(0, '% bien\n');
    await until(() => text(h.docs.get('main.pltx')).includes('% bien'));
    await h.host.end();
  });
});
