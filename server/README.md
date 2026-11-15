# Relé de Pyx

El único servidor que necesitan las sesiones compartidas de Pyx. Reenvía bytes **cifrados** entre
el anfitrión y sus invitados; no tiene ninguna clave, así que no puede leer ni falsificar nada.

- Arrancar: `npm install --omit=dev && node relay.mjs` (o `docker build -t pyx-relay . && docker run -p 8787:8787 pyx-relay`).
- Variables: `PORT` (8787), `HOST` (0.0.0.0), `TLS_CERT` + `TLS_KEY` (servir `wss://` directamente),
  `TRUST_PROXY=1` (detrás de Caddy/nginx; ver `Caddyfile.example`).
- `GET /health` responde `ok`.
- Límites contra abusos: tamaño de mensaje, bytes por segundo por conexión, invitados por sala,
  conexiones por IP, salas por servidor, mensajes de quien aún no ha sido aceptado, latidos, y las
  salas desaparecen 10 minutos después de irse el anfitrión.

Detalles del protocolo en la cabecera de `relay.mjs` y en `js/collab/session.js`. Guía de uso:
`Manual de usuario/colaboracion.md`.
