export const VERSION = '1.0.0';

export const config = {
  port: Number(process.env.PORT ?? 9000),
  systemUrl: process.env.SYSTEM_URL ?? 'http://localhost:8080',
  /** Adresse à laquelle k6 (lancé dans ce conteneur) joint l'orchestrateur. */
  selfUrl: `http://127.0.0.1:${Number(process.env.PORT ?? 9000)}`,
  /** Nom du projet Docker Compose dont le harnais peut redémarrer les conteneurs. */
  composeProject: process.env.COMPOSE_PROJECT ?? 'quinze-minutes',
  dockerSocket: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
  reportDir: process.env.REPORT_DIR ?? '/reports',
  /** Fichier JSON de pannes supplémentaires (la panne surprise du game day), jamais versionné. */
  surpriseFile: process.env.SURPRISE_FILE,
  signingKey: process.env.SIGNING_KEY ?? 'quinze-minutes-harnais-v1',
  /** Budget de ressources de la stack d'un groupe (contrat, « Branchement »). */
  budget: {
    cpus: Number(process.env.BUDGET_CPUS ?? 4),
    memoryGb: Number(process.env.BUDGET_MEMORY_GB ?? 4),
  },
  /** Multiplie toutes les durées simulées (préparation, trajets, délais du PSP). */
  timeScale: Number(process.env.TIME_SCALE ?? 1),
};
