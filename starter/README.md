# Quinze Minutes — le starter

Le back-end de départ, commun à tous les groupes. Il **fonctionne à faible charge**. À vous de le faire tenir la mi-temps.

Le contrat avec le harnais est dans [../contrat/](../contrat/README.md) : c'est la seule chose que vous ne pouvez pas changer. Tout le reste (code, découpage en services, événements, schéma de base) vous appartient.

## Lancer

```bash
docker compose up --build
```

Dans un autre terminal, le test de fumée (une poignée de commandes, puis vérification de l'audit et des invariants) :

```bash
docker compose run --rm harness node src/smoke.ts
```

Il doit finir sur `SMOKE OK`.

| Outil | Adresse |
|---|---|
| Page live du harnais (lancer un palier, suivre le score) | http://localhost:9000 |
| Grafana (dashboard « Quinze Minutes », sans connexion) | http://localhost:3001 |
| Prometheus | http://localhost:9090 |
| RabbitMQ (identifiant et mot de passe : `quinze`) | http://localhost:15672 |
| Inspecteur de Node (profil CPU, mémoire) : `chrome://inspect` → *Configure…* | `localhost:9229` commandes, `9230` paiement, `9231` dispatch, `9232` suivi |

Lancer un palier en ligne de commande : `docker compose exec harness node src/run.ts palier-1`.

L'inspecteur n'est publié que sur votre machine (`127.0.0.1`) : ne le changez pas en `0.0.0.0`, il donnerait à n'importe qui sur le réseau le droit d'exécuter du code dans vos services.

## Observabilité fournie

Prometheus, Tempo et Grafana tournent avec la stack, hors budget de ressources.

- **Métriques** : Prometheus interroge `GET /metrics` sur le port 3000 de chaque service ([observabilite/prometheus.yml](observabilite/prometheus.yml)). Le dashboard de départ attend les métriques par défaut de `prom-client` et un histogramme `http_request_duration_seconds` (labels `method`, `route`, `status_code`).
- **Traces** : Tempo reçoit l'OTLP sur `http://tempo:4318`, déjà dans `OTEL_EXPORTER_OTLP_ENDPOINT` ; `OTEL_SERVICE_NAME` est posé pour chaque service.

## Budget de ressources

4 CPU et 4 Go au total, hors harnais et observabilité, avec une limite sur chaque conteneur. Le harnais le vérifie à chaque passage. La répartition de départ est dans [compose.yaml](compose.yaml) : à vous de la changer si besoin.

## Architecture

```
            harnais (clients + PSP, restaurants, livreurs simulés)
                 │                                  ▲
                 ▼                                  │ PARTNERS_URL
          gateway nginx :8080                       │
   ┌──────────┬───────────┬───────────┬─────────────┤
   ▼          ▼           ▼           ▼             │
commandes  paiement    dispatch     suivi ──────────┘
   │          │           │           │
   └──────────┴─── RabbitMQ (exchange topic « quinze ») ───┘
              Postgres (une base, toutes les tables)   Redis (positions)
```

| Service | Rôle | Routes du contrat |
|---|---|---|
| `commandes` | création et cycle de vie des commandes, chargement du monde, audit | `POST /orders`, `GET /orders/{id}`, `/admin/world`, `/audit`, `/health/*` |
| `paiement` | débit et remboursement via le PSP | `POST /webhooks/psp` |
| `dispatch` | envoi en cuisine, choix du livreur, estimation des délais (ETA) | `POST /webhooks/restaurants`, `POST /webhooks/couriers` |
| `suivi` | flux SSE par commande, dernières positions des livreurs | `GET /orders/{id}/events`, `POST /webhooks/couriers/positions` |

Le routage est dans [gateway/nginx.conf](gateway/nginx.conf). Les tables sont dans [migrations/](migrations/), appliquées par le conteneur `migrate` au démarrage.

## Événements internes (RabbitMQ)

Exchange `quinze` (topic). Chaque service a sa file durable, nommée comme lui.

| Clé de routage | Publié par | Consommé par | Contenu |
|---|---|---|---|
| `order.created` | commandes | paiement | instantané de la commande (`OrderSnapshot`) |
| `order.status_changed` | commandes | dispatch, suivi | instantané de la commande avec son nouveau statut |
| `payment.succeeded` · `payment.failed` · `payment.refunded` | paiement | commandes | `{ orderId, paymentId }` |
| `refund.requested` | commandes | paiement | `{ orderId }` |
| `kitchen.accepted` · `kitchen.refused` · `kitchen.ready` | dispatch | commandes | `{ orderId }` |
| `courier.assigned` | dispatch | commandes, suivi | `{ orderId, courierId, etaSeconds }` |
| `courier.picked_up` · `courier.delivered` | dispatch | commandes | `{ orderId, courierId }` |
| `order.eta` | dispatch | commandes, suivi | `{ orderId, etaSeconds }` |
| `world.reset` | commandes | dispatch, suivi | `{}` |

`OrderSnapshot` est défini dans [lib/types.ts](lib/types.ts).

## Le déroulé d'une commande, côté code

1. `commandes` crée la commande (`payment_pending`) et publie `order.created`.
2. `paiement` demande le débit au PSP ; le webhook du PSP fait publier `payment.succeeded`.
3. `commandes` passe la commande à `paid` et publie `order.status_changed`.
4. `dispatch` l'envoie en cuisine (`kitchen.accepted` → `in_kitchen`), puis choisit le livreur qui livrera le plus tôt (`courier.assigned`).
5. Les webhooks des restaurants et des livreurs font avancer la commande jusqu'à `delivered`.
6. `suivi` pousse chaque étape, les positions du livreur et l'ETA aux clients connectés en SSE.

## Développer

- Node 24 exécute directement le TypeScript (pas de build). Vérifier les types : `npm install` puis `npm run typecheck`.
- Configuration par variables d'environnement : voir [lib/config.ts](lib/config.ts). `ETA_GRID_SIZE` règle la finesse de la grille de rues utilisée pour les ETA.
