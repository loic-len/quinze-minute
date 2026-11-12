# Projet « Quinze Minutes »

*Sujet distribué aux étudiants — Node.js avancé, EPITA MTI S9.*

## Le pitch

Demi-finale de la Coupe du monde, France–Espagne. Coup de sifflet de la mi-temps : pendant **15 minutes**, toute la France ouvre l'application et commande à manger. Puis la deuxième mi-temps reprend, et plus personne.

Vous reprenez le back-end d'une start-up de livraison de repas. Il fonctionne… le mardi soir à 21 h. Votre mission : qu'il tienne la mi-temps, sans jamais débiter deux fois un client, sans perdre une commande payée et sans envoyer un livreur sur deux courses à la fois.

Tous les groupes partent **du même code** et seront jugés **par le même crash-test**.

## Ce qu'on vous donne

- **Le contrat** ([contrat/](contrat/README.md)) : ce que votre système expose (API client, suivi SSE, webhooks des partenaires, `/admin/world`, `/audit`) et ce que le harnais expose (PSP, restaurants, livreurs). **Il est figé** : le harnais ne parle à votre système qu'à travers lui. Les événements RabbitMQ internes n'en font pas partie : vous en faites ce que vous voulez.
- **Le starter** : une stack Node 24 + Postgres + Redis + RabbitMQ, en Docker Compose, avec 4 services :
  - `commandes` : API publique, cycle de vie de la commande ;
  - `paiement` : appels au PSP, réception de ses webhooks ;
  - `dispatch` : capacité des cuisines, assignation des livreurs, calcul d'ETA ;
  - `suivi` : statut et position du livreur en temps réel (WebSocket/SSE).

  Il **marche à faible charge** et il est **naïf exprès**. Vous êtes libres de le refactorer, de redécouper les services ou d'en ajouter, tant que le contrat est respecté et que vous restez dans les limites CPU/RAM fixées par le `compose.yaml`.
- **Le harnais** : une image Docker à lancer contre votre stack. Elle contient :
  - la courbe de charge d'un match (avant-match, pic de mi-temps, reprise) ;
  - des partenaires simulés (PSP, restaurants, GPS des livreurs) qui savent ralentir, doubler, désordonner et tomber ;
  - un vérificateur d'invariants ;
  - Prometheus, Grafana et Tempo prêts à l'emploi ;
  - un score par palier.

## Les invariants (zéro tolérance)

Le vérificateur compare votre `/audit` à son propre grand livre. Une seule violation d'invariant fait échouer un palier :

1. Un client n'est **jamais débité deux fois** pour une même commande.
2. Une commande **payée n'est jamais perdue** : elle finit livrée, ou annulée et remboursée.
3. Un livreur n'a **jamais deux courses** en même temps.
4. La **capacité d'une cuisine** n'est jamais dépassée.
5. Le statut d'une commande **ne recule jamais** (`livrée` ne redevient pas `en préparation`).

## Les paliers

Un palier est débloqué à chaque session ; vous le franchissez en TP et le finissez à la maison si besoin. Un classement provisoire est publié chaque semaine.

| Palier | Session | Ce que le harnais fait | Pour le franchir |
|---|---|---|---|
| 1 · Charge | S1 | courbe de mi-temps, redémarrage d'un conteneur en plein pic | p95 de la prise de commande sous le seuil au pic, zéro commande perdue |
| 2 · Lenteur cachée | S2 | un restaurant partenaire devient lent | trace bout en bout, 3 SLO mesurés, restaurant coupable désigné |
| 3 · Doublons et désordre | S3 | rejeu de requêtes, webhooks en double, événements désordonnés | zéro violation d'invariant |
| 4 · Chaos | S4 | PSP en panne 2 min, restaurant lent, Redis tué, conteneur tué | SLO tenus hors dépendance coupée, récupération seule, zéro violation |

Les seuils chiffrés de chaque palier sont publiés avec le harnais.

## Le game day

Environ 2 semaines après la dernière session. Chaque groupe passe le scénario final en direct sur une machine de référence, classement projeté, avec **une panne surprise** que personne n'a vue avant. Juste après : un post-mortem oral de 5 minutes.

## Rendu

- Le dépôt du groupe (code, `compose.yaml`, README de lancement).
- Les tests des cas critiques (concurrence, idempotence).
- Un document `SLO.md` : vos 3 SLO et leur justification.
- Un `POST-MORTEM.md` écrit après le game day (1–2 pages) : chronologie, cause, détection, ce que vous changeriez.

## Notation

La note repose sur des **critères atteignables par tous les groupes** ; le classement ne donne qu'un bonus.

| Critère | Poids |
|---|---|
| Paliers 1 à 4 franchis (le vérificateur fait foi) | 40 % |
| Game day, sur seuils absolus (SLO tenus, zéro violation d'invariant) | 20 % |
| Qualité : tests des cas critiques, lisibilité, choix expliqués | 20 % |
| `SLO.md` + `POST-MORTEM.md` | 20 % |
| **Bonus podium** du game day | +1 / +0,5 / +0,25 |

Les lots du podium sont des goodies.

## Organisation

- Groupes de 4. Charge visée : ≈ 20 h par étudiant, dont ≈ 7 h en session.
- Le temps de TP est fait pour avancer le projet : un groupe qui travaille bien en session a peu à faire chez lui.
- Les TP sont conçus pour être répartis à 4 : chaque palier contient des tâches parallélisables.
