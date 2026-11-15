// Pyx en el navegador, para probar las sesiones compartidas sin instalar nada:
// sirve la app compilada (dist/, `npm run build`) y el relé en el MISMO puerto
// (la app se conecta a /relay de la misma dirección).
//
//   npm run build && node server/try.mjs        →  http://localhost:3042
//
// En el navegador no hay Python ni LaTeX (eso lo pone la app de escritorio):
// se prueba la edición a la vez, los permisos, los cursores y los ratones.

import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from './relay.mjs';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.dic': 'text/plain; charset=utf-8',
  '.aff': 'text/plain; charset=utf-8', '.map': 'application/json', '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
};

function serve(req, res) {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/index.html';
  const file = normalize(join(DIST, path));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  let st;
  try { st = statSync(file); } catch (_) { st = null; }
  if (!st || !st.isFile()) { res.writeHead(404); res.end('No encontrado'); return; }
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': st.size,
    'cache-control': path === '/index.html' ? 'no-cache' : 'public, max-age=3600',
  });
  createReadStream(file).pipe(res);
}

const relay = createRelay({
  port: +(process.env.PORT || 3042),
  host: process.env.HOST || '127.0.0.1',
  trustProxy: true,
  onRequest: serve,
});
relay.listen().then((a) => relay.log(`Pyx de prueba en http://${a.address}:${a.port} (relé en /relay)`));
