# Relé de Pyx

El único servidor que necesitan las sesiones compartidas de Pyx. Reenvía bytes **cifrados** entre
el anfitrión y sus invitados; no tiene ninguna clave, así que no puede leer ni falsificar nada.
No guarda nada en disco y ningún ordenador de la sesión abre puertos.

## Ponerlo en marcha (una vez)

Elige una de las tres. En todas, la dirección que se escribe en Pyx empieza por `wss://`.

### A. Render (lo más sencillo, sin terminal)

1. Crea una cuenta en <https://render.com> y conéctala a GitHub.
2. **New → Blueprint**, elige este repositorio y acepta. Render lee `render.yaml`, construye la
   imagen de `server/Dockerfile` y pone el certificado TLS.
3. Cuando termine, la dirección es `wss://<nombre-del-servicio>.onrender.com`.

En el plan gratuito el servicio se duerme tras 15 minutos sin conexiones y tarda cerca de un
minuto en despertar: la primera persona que comparte espera ese rato; mientras haya una sesión
abierta no se duerme. Para un uso serio, el plan de pago más pequeño lo mantiene siempre despierto.

### B. Fly.io

```bash
cd server
fly launch --copy-config --no-deploy   # elige un nombre; usa server/fly.toml
fly deploy
```

La dirección es `wss://<app>.fly.dev`.

### C. Un servidor propio (Docker o Node 20+)

```bash
cd server
docker build -t pyx-relay .
docker run -d --restart=always -p 127.0.0.1:8787:8787 -e TRUST_PROXY=1 pyx-relay
```

y delante un proxy con certificado TLS, por ejemplo Caddy con `Caddyfile.example` (Caddy obtiene
el certificado solo). Sin Docker: `npm install --omit=dev && node relay.mjs`.

## Que todos los usuarios lo tengan ya puesto

Escribe la dirección en `js/collab/default-relay.js` (`DEFAULT_RELAY`) y publica una versión:
«Compartir» propone ese servidor a todo el mundo y nadie tiene que escribir nada. Quien quiera
usar otro puede cambiarlo en el propio diálogo.

## Referencia

- Variables: `PORT` (8787), `HOST` (0.0.0.0), `TLS_CERT` + `TLS_KEY` (servir `wss://`
  directamente), `TRUST_PROXY=1` (detrás de un proxy: Render, Fly, Caddy, nginx).
- `GET /health` responde `ok`.
- Límites contra abusos: tamaño de mensaje, bytes por segundo por conexión, invitados por sala
  (32), conexiones por IP, salas por servidor, mensajes de quien aún no ha sido aceptado, latidos,
  y las salas desaparecen 10 minutos después de irse el anfitrión. Ningún mensaje de un cliente
  puede detener el servidor.
- Para probar en un solo ordenador: `npm run relay` (en la raíz) y la dirección
  `ws://localhost:8787`. Sin TLS solo se admite `localhost`.

Detalles del protocolo en la cabecera de `relay.mjs` y en `js/collab/session.js`. Guía de uso:
`Manual de usuario/colaboracion.md`.
