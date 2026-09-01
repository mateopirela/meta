# Recuperación de DMs — imagen para Cloud Run.
# Sin dependencias: no hay npm install. Node 24 nativo, igual que en local.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY src ./src
COPY web ./web

# Cloud Run inyecta PORT (8080) y K_SERVICE; con K_SERVICE el server escucha en 0.0.0.0.
EXPOSE 8080
USER node
CMD ["node", "web/server.mjs"]
