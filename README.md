# Quinze Minutes

Projet du cours « Node.js avancé », EPITA MTI S9.

Demi-finale France–Espagne, coup de sifflet de la mi-temps : pendant 15 minutes, tout le monde commande à manger en même temps. Vous reprenez le back-end d'une start-up de livraison de repas, et votre travail est de le faire tenir.

## Ce qu'il y a dans l'archive

| Dossier ou fichier | Ce que c'est | Vous pouvez le modifier ? |
|---|---|---|
| [SUJET.md](SUJET.md) | le sujet complet : pitch, règles, paliers, rendu, notation | — |
| [TP-S1.md](TP-S1.md) | le TP de la séance 1 et le palier 1 | — |
| [MEMO-S1.md](MEMO-S1.md) | le mémo de la séance 1 : les notions, les commandes, les liens | — |
| [starter/](starter/README.md) | le back-end de départ : 4 services Node, Postgres, Redis, RabbitMQ | **oui, tout** |
| [contrat/](contrat/README.md) | les URL et les formats échangés entre votre système et le harnais | **non** |
| [harnais/](harnais/README.md) | l'arbitre : il joue les clients et les partenaires, vérifie les règles et calcule le score | **non** |

Le contrat et le harnais sont les mêmes pour tous les groupes. Au game day, c'est ma version du harnais qui tourne : une modification de votre côté ne vous apporterait rien.

## Démarrer

Prérequis : Docker avec Compose v2 (Docker Desktop sur macOS et Windows). Node 24 n'est utile que pour vérifier les types sur votre machine.

La stack est limitée à 4 CPU, auxquels s'ajoutent le harnais, Prometheus, Grafana et Tempo. Donnez à Docker le plus de cœurs et de mémoire possible (Docker Desktop → *Settings* → *Resources*). Sur une petite machine, vos mesures seront plus pessimistes que sur celle du game day.

```bash
cd starter
docker compose up -d --build
docker compose run --rm harness node src/smoke.ts
```

Le test de fumée doit finir sur `SMOKE OK`. Ouvrez ensuite la page live du harnais sur http://localhost:9000 et Grafana sur http://localhost:3001. Toutes les adresses sont dans [starter/README.md](starter/README.md).

Puis lisez [TP-S1.md](TP-S1.md).

## En groupe

Vous travaillez par groupes de 4. Mettez **tout le dossier** (le starter, le contrat et le harnais) dans le dépôt Git de votre groupe : le `compose.yaml` du starter construit le harnais depuis `../harnais`.

```bash
git init
git add .
git commit -m "Starter Quinze Minutes"
```
