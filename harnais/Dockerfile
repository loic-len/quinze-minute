FROM grafana/k6:1.2.0 AS k6

FROM node:24.11-alpine

COPY --from=k6 /usr/bin/k6 /usr/bin/k6

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src src
COPY k6 k6
COPY public public
COPY mondes mondes

# Le harnais tourne en root : il pilote Docker via le socket monté par compose.yaml.
EXPOSE 9000
CMD ["node", "src/main.ts"]
