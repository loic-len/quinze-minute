# Contrat « Quinze Minutes » — v1.2.0

Le contrat est la **seule** frontière entre votre système et le harnais. Tout le reste vous appartient : découpage en services, événements RabbitMQ internes, schémas de base, langages de requête.

| Fichier | Qui l'implémente | Qui l'appelle |
|---|---|---|
| [systeme.openapi.yaml](systeme.openapi.yaml) | **votre système** (point d'entrée unique, port 8080) | le harnais : clients, webhooks des partenaires, pilotage |
| [partenaires.openapi.yaml](partenaires.openapi.yaml) | le harnais (PSP, restaurants, livreurs) | **votre système** |
| [exemples/monde.json](exemples/monde.json) | — | exemple de monde chargé par `POST /admin/world` |

## Branchement

- Votre stack expose **un seul** point d'entrée HTTP, sur le port `8080`, pour toutes les routes de `systeme.openapi.yaml`.
- Votre système lit l'adresse du harnais dans la variable d'environnement `PARTNERS_URL` (par exemple `http://harness:9000`).
- **Budget de ressources** de toute la stack (vos services, bases, bus, gateway) : **4 CPU et 4 Go** au total, en limites Docker (`deploy.resources.limits`) posées sur **chaque** conteneur. L'observabilité et le harnais sont hors budget. Le harnais additionne les limites des conteneurs en marche à chaque passage : un conteneur sans limite, ou un total au-dessus du budget, fait échouer le palier.

## Pannes provoquées par le harnais

Pendant les paliers, le harnais pilote Docker (socket monté dans son conteneur) et agit sur les conteneurs de votre projet Compose, selon leurs **labels** :

| Label du conteneur | Ce que le harnais peut lui faire |
|---|---|
| *(aucun label `quinze.role`)* | conteneur **applicatif** : redémarrage (SIGTERM, 10 s pour s'arrêter proprement) ou SIGKILL suivi d'une relance |
| `quinze.role: infra` | jamais choisi au hasard (bases, bus, gateway, migrations…) |
| `quinze.infra: redis` (ou `postgres`, `rabbitmq`) | arrêté puis relancé pendant un palier qui l'annonce |
| `quinze.role: observability` | Prometheus, Grafana, Tempo… : jamais touché, hors budget |
| `quinze.role: harness` | le harnais lui-même |

Vos services applicatifs ne portent **pas** de label `quinze.role` ; tout composant d'infrastructure que vous ajoutez porte `quinze.role: infra`. Un service applicatif marqué `infra` pour échapper aux pannes est considéré comme une triche.

## Le déroulé d'une commande

```
client ──POST /orders──▶ système ──POST /psp/payments──▶ PSP
                                  ◀──webhook payment.succeeded──
        système ──POST /restaurants/{id}/orders──▶ cuisine
                                  ◀──webhook order.ready──
        système ──POST /couriers/{id}/assignments──▶ livreur
                                  ◀──positions GPS (en continu)──
                                  ◀──webhook order.picked_up──
                                  ◀──webhook order.delivered──
client ◀──SSE /orders/{id}/events── système (à chaque étape)
```

Le moment où vous assignez le livreur est libre : dès le paiement, pendant la préparation ou à `order.ready`. Ce choix fait partie de votre stratégie de dispatch.

## Statuts et transitions

| De | Vers | Déclencheur |
|---|---|---|
| — | `payment_pending` | `POST /orders` accepté |
| `payment_pending` | `paid` | webhook `payment.succeeded` |
| `payment_pending` | `cancelled` (`payment_failed`) | webhook `payment.failed` |
| `paid` | `in_kitchen` | 200 du restaurant |
| `paid` | `cancelled` (`restaurant_refused`) | 422 du restaurant, **remboursement obligatoire** |
| `in_kitchen` | `ready` | webhook `order.ready` |
| `ready` | `picked_up` | webhook `order.picked_up` |
| `picked_up` | `delivered` | webhook `order.delivered` |
| `paid`, `in_kitchen`, `ready` | `cancelled` (`no_courier`) | décision du système (mode dégradé), **remboursement obligatoire** |

Règles :

- **Un statut ne recule jamais.** Un événement qui ferait reculer la commande (par exemple `order.ready` reçu après `order.picked_up`) est ignoré, avec une réponse 2xx.
- **Un événement peut faire sauter des étapes** : `order.picked_up` reçu avant `order.ready` implique que la commande est prête (et libère la place en cuisine).
- `delivered` et `cancelled` sont terminaux.
- Une commande annulée pendant `in_kitchen` occupe sa place jusqu'à `order.ready` : la cuisine prépare quand même.

## Garanties de livraison

| Canal | Garantie |
|---|---|
| Webhooks PSP, restaurants, livreurs | **au moins une fois** : doublons possibles (même `eventId`), retards, désordre. Nouvelle livraison si pas de 2xx en 5 s. |
| Positions GPS | au plus une fois, par lots, environ un lot par seconde ; une position plus ancienne que la dernière connue est ignorée |
| Appels du système vers les partenaires | aucune garantie : un partenaire peut répondre lentement, en 503, ou jamais. Le PSP et les remboursements sont idempotents sur `Idempotency-Key`, la cuisine et les livreurs sur `orderId`. |
| Clients simulés | timeout de 5 s, jusqu'à 3 nouvelles tentatives **avec la même `Idempotency-Key`** ; `Retry-After` respecté sur 429 et 503 |

## Invariants

Une seule violation fait échouer le palier en cours. La colonne « Détecté par » dit qui vous prend en défaut : les partenaires simulés tiennent leur propre grand livre et n'ont pas besoin de vous croire.

| # | Invariant | Détecté par |
|---|---|---|
| 1 | Un client n'est **jamais débité deux fois** : au plus un paiement réussi et non remboursé par commande | le PSP |
| 2 | Une commande **payée n'est jamais perdue** : à la fin (après la période de grâce), elle est `delivered`, ou `cancelled` avec son paiement remboursé. Toute commande acquittée par un 201 apparaît dans `/audit` | le vérificateur (`/audit` + grand livre du PSP) |
| 3 | Un livreur n'a **jamais deux courses** en même temps | les livreurs (409 `courier_busy`) |
| 4 | La **capacité d'une cuisine** n'est jamais dépassée | les restaurants (409 `kitchen_full`) |
| 5 | Le statut d'une commande **ne recule jamais** | le vérificateur (`statusHistory` de `/audit` + flux SSE observés) |

Une commande `cancelled` ne doit avoir **aucun** paiement réussi non remboursé, et une commande `delivered` en a **exactement un**.

## Conventions

- Montants en centimes d'euro (`amountCents`, entier). Dates en ISO 8601 UTC.
- Erreurs au format RFC 9457 (`application/problem+json`).
- Surcharge : répondre **vite** en 503 (ou 429 pour une limite par client) avec `Retry-After`, plutôt que de laisser le client tomber en timeout.
- `POST /admin/world` remet tout à zéro : le harnais l'appelle avant chaque scénario, puis attend `GET /health/ready` = 200.

## Versions

- **v1.2.0** : budget de ressources fixé (4 CPU, 4 Go) et label `quinze.role: observability`. Aucune route ne change.
- **v1.1.0** : ajout des labels de pannes (section « Pannes provoquées par le harnais »). Aucune route ne change.
- Le contrat suit semver. Une version **mineure** ajoute seulement des champs ou des routes facultatifs ; elle n'impose rien aux groupes.
- Une fois le contrat distribué, une version **majeure** n'arrive que si elle est indispensable. Elle est annoncée à tous les groupes en même temps, avec le harnais compatible.
