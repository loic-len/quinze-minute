FROM node:24.11-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY lib lib
COPY services services
COPY migrations migrations

USER node
# Chaque service de compose.yaml choisit son point d'entrée (node services/<nom>/main.ts).
