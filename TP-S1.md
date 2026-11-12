# TP de la séance 1 : palier 1 « Charge »

Le starter marche en temps normal, mais il s'effondre à la mi-temps : les commandes sont acceptées, puis presque plus rien n'est livré. Votre objectif cette semaine est qu'il tienne le pic, et qu'il ne perde aucune commande quand un de ses conteneurs redémarre.

## Ce que fait le palier 1

Un passage dure environ 6 minutes :

| Phase | Durée | Commandes par seconde |
|---|---|---|
| Avant-match | 60 s | 2 |
| Coup de sifflet | 30 s | de 2 à 12 |
| Mi-temps | 120 s | 12 |
| Reprise | 60 s | 2 |

Ensuite vient une période de grâce d'une minute : les commandes encore en cours ont le temps de se terminer. Et à **150 s**, en plein pic, le harnais redémarre un de vos services (SIGTERM).

## Pour franchir le palier

1. **Aucune commande payée perdue** : elle finit livrée, ou annulée et remboursée (règle 2 du sujet).
2. Le **p95 de `POST /orders`** au pic reste **sous 1 s**.
3. Au moins **95 %** des commandes sont terminées.
4. La stack reste dans le **budget** : 4 CPU et 4 Go au total, avec une limite sur chaque conteneur.

Le rapport affiche aussi les autres règles du sujet. Elles ne sont pas encore bloquantes (elles le deviendront au palier 3), mais regardez-les : elles montrent ce qui vous attend.

## Lancer un passage

Depuis `starter/`, la stack démarrée :

```bash
docker compose exec harness node src/run.ts palier-1
```

Vous pouvez aussi le lancer depuis la page live, sur http://localhost:9000. Le rapport commence par le verdict et le score, puis il détaille chaque critère avec sa mesure. Il est écrit dans `starter/rapports/`.

Ce rapport est pour vous : vous n'avez pas à me le rendre. Il vous dit où vous en êtes.

Un conseil : ne relancez pas le palier en boucle en espérant que ça passe. Mesurez, corrigez, et seulement ensuite, relancez.

## Les quatre chantiers

Un chantier par personne. Ce sont les étapes de l'enquête qu'on a faite ensemble en séance.

1. **La baseline.** À faire en premier, avant de toucher au code. Passez le palier sur le starter tel quel et notez le p95, le nombre de commandes livrées et le CPU de chaque conteneur. Sans mesure de départ, vous ne saurez jamais si vous avez progressé.
2. **Le calcul de `dispatch`.** Profilez `dispatch` au pic (inspecteur sur `localhost:9231`, voir le mémo), trouvez ce qui occupe l'event loop, calculez moins, puis sortez le reste du thread principal dans un pool de workers.
3. **L'arrêt propre.** Readiness et graceful shutdown dans les 4 services, et dans `dispatch`, la reprise du travail en cours au démarrage, à partir de la base.
4. **Le budget.** Regardez `docker stats` au pic, puis répartissez vos 4 CPU là où ils servent.

Mettez ensuite tout en commun et passez le palier.

## Ce que vous pouvez toucher

- **Le starter est à vous** : le code, le découpage en services, les messages RabbitMQ, le schéma de la base, la répartition du budget dans `compose.yaml`.
- **Le contrat et le harnais sont figés.** Vous lancez le harnais, vous ne le modifiez pas.
- **Les cinq règles du sujet ne se négocient pas.**
- Le harnais provoque des pannes sur vos services, jamais sur l'infrastructure (Postgres, Redis, RabbitMQ). Déclarer un de vos services comme de l'infrastructure pour qu'il y échappe ne passe pas : le harnais le voit.
