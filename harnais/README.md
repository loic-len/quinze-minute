# Harnais Quinze Minutes

L'arbitre commun à tous les groupes. Il joue les clients (k6), le prestataire de paiement (PSP), les restaurants et les livreurs ; il provoque les pannes du palier, vérifie les règles du sujet et calcule le score.

**Vous le lancez, vous ne le modifiez pas.** Il tourne comme un conteneur de votre stack (le service `harness` de `starter/compose.yaml`), hors du budget de 4 CPU. Au game day, c'est ma version qui tourne.

## Lancer un palier

Depuis le dossier de la stack (`starter/`), la stack démarrée (`docker compose up -d --build`) :

```bash
docker compose exec harness node src/run.ts palier-1
```

Ou depuis la page live : http://localhost:9000 (choisir le palier, puis « Lancer »).

Un passage dure environ 6 minutes, période de grâce comprise. Le rapport signé est écrit dans `rapports/`, à côté du `compose.yaml`.

Test de fumée (8 commandes, sans panne) :

```bash
docker compose run --rm harness node src/smoke.ts
```

## Accès à Docker

Pour redémarrer ou tuer vos conteneurs pendant les paliers, le harnais a besoin du socket Docker (`/var/run/docker.sock`, monté par `compose.yaml`). Il ne touche qu'aux conteneurs du projet Compose `quinze-minutes`.
