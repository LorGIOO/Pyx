# Relé de Pyx: una imagen mínima, sin privilegios y sin nada que guardar.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY relay.mjs ./
USER node
ENV PORT=8787 HOST=0.0.0.0
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "relay.mjs"]
