# Mémo de la séance 1 : un process Node sous charge

Ce qu'on a vu en séance, pour s'y retrouver pendant le TP. Les liens mènent à la documentation officielle.

## 1. L'event loop

- **Node n'est pas mono-thread, mais votre JavaScript, si.** Les requêtes HTTP, les messages du bus, les timers et vos calculs passent tous par le même thread. Tant qu'il calcule, il ne fait rien d'autre.
- **Un tour d'event loop** passe par des phases, toujours dans le même ordre : *timers* (`setTimeout`), *poll* (les entrées-sorties prêtes ; c'est là que Node attend), *check* (`setImmediate`), puis *close*. Après **chaque** callback, Node vide les microtâches : d'abord `process.nextTick`, puis les promesses.
- Conséquence : un callback qui dure 1 s, c'est un tour d'event loop qui dure 1 s pour tout le monde.
- **Ce qui bloque l'event loop** : le calcul (CPU), les fonctions `*Sync` (acceptables au démarrage, jamais dans un handler), `JSON.parse` et `JSON.stringify` sur de gros objets, et les regex sur une entrée piégée (ReDoS).
- `async` / `await` ne rend pas un calcul non bloquant : `await` rend la main pendant une attente d'entrée-sortie, pas pendant un calcul.
- **Le threadpool de libuv** : 4 threads par défaut (`UV_THREADPOOL_SIZE`, à fixer au démarrage) pour les fichiers, `dns.lookup`, `crypto` et `zlib`. Le réseau, lui, n'utilise pas de thread. Si les 4 threads sont occupés, la 5ᵉ tâche attend, même si l'event loop est libre.

Pour aller plus loin : [The Node.js Event Loop](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick) · [Don't Block the Event Loop](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)

## 2. Mesurer avant d'optimiser

- **La moyenne ment.** Quand il y a deux populations (des requêtes rapides et des requêtes qui attendent), la moyenne donne une valeur que personne n'a vécue. On regarde les percentiles.
- **p50** : une requête sur deux fait mieux. **p95** : une sur vingt fait pire ; à 12 commandes par seconde, ça fait 36 clients par minute. **p99** : une sur cent ; il est sensible aux événements isolés (garbage collector, redémarrage, rafale). Un percentile se donne toujours avec sa fenêtre et son nombre de requêtes.
- Le palier est jugé sur le **p95** parce qu'il donne le même verdict d'un passage à l'autre ; le p99 varie trop. Il reste dans le rapport et départage le classement.
- **Mesurer l'event loop elle-même** avec `monitorEventLoopDelay` ([perf_hooks](https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions)) :

  ```ts
  import { monitorEventLoopDelay } from 'node:perf_hooks';

  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  setInterval(() => {
    // valeurs en nanosecondes : ÷ 1e6 pour des millisecondes
    console.log(`event loop lag p50=${(h.percentile(50) / 1e6).toFixed(1)} ms p99=${(h.percentile(99) / 1e6).toFixed(1)} ms`);
    h.reset();
  }, 5_000).unref();
  ```

  Quelques millisecondes : tout va bien. Quelques dizaines : ça chauffe. Quelques centaines : vos clients attendent.
- **Envoyer de la charge : modèle ouvert ou fermé.** Un outil fermé (autocannon, 50 connexions) attend chaque réponse avant d'envoyer la suivante : quand le serveur ralentit, la charge baisse toute seule et le test évite le problème (*coordinated omission*). Un outil ouvert (k6 à débit fixé, et le harnais) envoie au rythme demandé, que le serveur suive ou non. Une mi-temps suit un modèle ouvert. [Open and closed models (k6)](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/)

## 3. Profiler

- L'inspecteur est déjà activé dans le starter : `chrome://inspect` → *Configure…* → `localhost:9229` à `9232` (commandes, paiement, dispatch, suivi). Dans DevTools, onglet *Performance*, enregistrez une dizaine de secondes **pendant le pic**.
- `node --cpu-prof` écrit le profil **à la sortie** du process : il faut que le process s'arrête proprement pour l'obtenir.
- **Lire un flamegraph** : la largeur, c'est le temps CPU ; la hauteur, c'est la pile d'appels. L'axe horizontal n'est pas le temps qui passe. On cherche la pile la plus large, puis on remonte vers votre code.
- **`docker stats`** : 100 % = un cœur. Un conteneur limité à 0,5 CPU qui affiche 50 % est au plafond : il est mis en pause jusqu'à la tranche de temps suivante.

Pour aller plus loin : [Debugging Node.js](https://nodejs.org/en/learn/getting-started/debugging) · [Profiling Node.js Applications](https://nodejs.org/en/learn/getting-started/profiling)

## 4. Sortir le CPU du thread principal

- **D'abord, calculer moins.** Un calcul inutile reste inutile, même parallélisé : avant les threads, demandez-vous si tout ce calcul est nécessaire.
- **`worker_threads`** : un autre thread, avec son propre V8 et sa propre event loop, qui ne partage rien par défaut. Deux coûts : chaque message est **copié** (envoyez peu de données), et le démarrage d'un worker est cher. [worker_threads](https://nodejs.org/api/worker_threads.html)
- **Un pool** crée les workers une fois et les garde. Avec [piscina](https://github.com/piscinajs/piscina) : un fichier qui exporte une fonction, `maxThreads`, et `pool.run(job)` qui renvoie une promesse. Le calcul ne va pas plus vite, mais il ne bloque plus les webhooks ni le bus.
- **Les workers ne créent pas de CPU.** Ils partagent le quota du conteneur avec le thread principal. Ils libèrent l'event loop, pas le calcul. Après avoir déplacé le calcul, relisez `docker stats` et répartissez le budget.
- **Le pool de connexions à la base** : quand toutes les connexions sont prises, une requête attend sa connexion, alors que l'event loop est libre. Si un consommateur du bus prend toutes les connexions, vos requêtes HTTP font la queue derrière lui. La bonne taille se mesure ; limiter le consommateur gourmand marche souvent mieux qu'ajouter des connexions. [node-postgres : Pool](https://node-postgres.com/apis/pool)

## 5. S'arrêter proprement

- **Liveness** : « le process répond-il ? ». Si non, l'orchestrateur le redémarre. Elle **n'interroge pas la base** : une base lente ferait redémarrer tous les services, et ce serait la panne totale.
- **Readiness** : « peut-il recevoir du trafic ? ». Si non, il ne reçoit plus de trafic, mais il n'est pas tué. Elle répond 503 au démarrage, pendant l'arrêt, et quand la base est injoignable. Dans le projet, la gateway et le harnais appellent `/health/ready`.
- **Au SIGTERM**, Docker laisse **10 s** avant le SIGKILL ([docker stop](https://docs.docker.com/reference/cli/docker/container/stop/)). Par défaut, Node s'arrête immédiatement et abandonne tout ce qui est en cours. L'ordre de l'arrêt propre :
  1. la readiness passe à 503 ;
  2. on arrête de consommer le bus et on finit les messages en cours ;
  3. on arrête le serveur HTTP en laissant finir les requêtes en cours ;
  4. on ferme les connexions (bus, pool Postgres, Redis) ;
  5. `process.exit(0)`.

  L'ordre est important : on ne ferme pas la base sous un message en cours de traitement. Ajoutez un timer de sécurité d'environ 8 s (`unref()`) pour sortir vous-même, avec un log, avant le SIGKILL.
- **Ce qui vit en mémoire meurt avec le process.** Une file d'attente gardée en mémoire est vide au redémarrage, et les commandes payées qu'elle contenait sont abandonnées. Au démarrage, reconstruisez le travail en cours à partir de la base. La mémoire d'un process est un cache ; la vérité est dans la base.

## À retenir

Votre JavaScript n'a qu'un seul thread : ne le bloquez pas. Mesurez avant de toucher quoi que ce soit. Calculez moins, sortez le reste dans un pool, et répartissez votre budget. Et préparez-vous au SIGTERM.
