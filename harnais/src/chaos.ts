// Pannes et pièges : réglages lus par les partenaires simulés, et actions Docker sur la stack du groupe.
import { request } from 'node:http';
import { config } from './config.ts';
import { log, sleep } from './util.ts';

export const knobs = {
  /** `unavailable` : 503 immédiat ; `hang` : le PSP ne répond plus. */
  psp: 'ok' as 'ok' | 'unavailable' | 'hang',
  /** Part des paiements traités dont la réponse est « perdue » (connexion coupée). */
  pspLoseResponseRate: 0,
  /** Part des webhooks livrés 2 ou 3 fois. */
  webhookDuplicateRate: 0,
  /** Part des `order.ready` notifiés après le `order.picked_up` du livreur. */
  readyAfterPickupRate: 0,
  /** Restaurant qui met 3 à 8 s à répondre à l'envoi en cuisine. */
  slowRestaurantId: undefined as string | undefined,
};

/** Pannes en cours, affichées sur la page live. */
export const activeFaults = new Set<string>();

export function resetChaos() {
  knobs.psp = 'ok';
  knobs.pspLoseResponseRate = 0;
  knobs.webhookDuplicateRate = 0;
  knobs.readyAfterPickupRate = 0;
  knobs.slowRestaurantId = undefined;
  activeFaults.clear();
}

// ---------------------------------------------------------------------------
// Docker (API du moteur via son socket Unix)
// ---------------------------------------------------------------------------

interface Container {
  Id: string;
  Names: string[];
  State: string;
  Labels: Record<string, string>;
}

function docker(method: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: config.dockerSocket, method, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('Docker ne répond pas')));
    req.end();
  });
}

async function projectContainers(): Promise<Container[]> {
  const filters = encodeURIComponent(
    JSON.stringify({ label: [`com.docker.compose.project=${config.composeProject}`] }),
  );
  const response = await docker('GET', `/containers/json?all=1&filters=${filters}`);
  if (response.status !== 200) throw new Error(`Docker : ${response.status} ${response.body}`);
  return JSON.parse(response.body) as Container[];
}

const nameOf = (c: Container) =>
  c.Labels['com.docker.compose.service'] ?? c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12);

/** Conteneurs applicatifs du groupe : tout sauf l'infrastructure (`quinze.role`) et le harnais. */
async function appContainers(): Promise<Container[]> {
  return (await projectContainers()).filter((c) => c.State === 'running' && !c.Labels['quinze.role']);
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await projectContainers();
    return true;
  } catch {
    return false;
  }
}

function pick<T>(items: T[]): T | undefined {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * Ressources réservées à la stack du groupe : somme des limites Docker de ses conteneurs en marche,
 * hors harnais et observabilité. Un conteneur sans limite est signalé.
 */
export async function stackResources(): Promise<{ cpus: number; memoryGb: number; unlimited: string[] }> {
  const containers = (await projectContainers()).filter(
    (c) =>
      c.State === 'running' &&
      c.Labels['quinze.role'] !== 'harness' &&
      c.Labels['quinze.role'] !== 'observability',
  );
  let cpus = 0;
  let memoryBytes = 0;
  const unlimited: string[] = [];
  for (const c of containers) {
    const inspect = await docker('GET', `/containers/${c.Id}/json`);
    const host = (JSON.parse(inspect.body) as { HostConfig: { NanoCpus: number; Memory: number } }).HostConfig;
    if (!host.NanoCpus || !host.Memory) unlimited.push(nameOf(c));
    cpus += host.NanoCpus / 1e9;
    memoryBytes += host.Memory;
  }
  return { cpus: Number(cpus.toFixed(2)), memoryGb: Number((memoryBytes / 1024 ** 3).toFixed(2)), unlimited };
}

interface CpuStats {
  cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number };
}

/**
 * CPU consommé (en cœurs) par chaque conteneur en marche du projet, hors harnais, et sa limite.
 * L'API Docker calcule l'écart sur ≈ 1 s ; tous les conteneurs sont lus en parallèle.
 */
export async function sampleCpu(): Promise<{ name: string; cores: number; limitCores: number | undefined }[]> {
  const containers = (await projectContainers()).filter(
    (c) => c.State === 'running' && c.Labels['quinze.role'] !== 'harness',
  );
  return Promise.all(
    containers.map(async (c) => {
      const [stats, inspect] = await Promise.all([
        docker('GET', `/containers/${c.Id}/stats?stream=false`),
        docker('GET', `/containers/${c.Id}/json`),
      ]);
      const s = JSON.parse(stats.body) as CpuStats;
      const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
      const systemDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
      const cores = systemDelta > 0 ? (cpuDelta / systemDelta) * (s.cpu_stats.online_cpus ?? 1) : 0;
      const nanoCpus = (JSON.parse(inspect.body) as { HostConfig: { NanoCpus: number } }).HostConfig.NanoCpus;
      const name = (c.Names[0] ?? c.Id).replace(/^\//, '').replace(`${config.composeProject}-`, '');
      return { name, cores, limitCores: nanoCpus ? nanoCpus / 1e9 : undefined };
    }),
  );
}

/** SIGTERM puis relance : ce que fait un déploiement. */
export async function restartRandomService(): Promise<string> {
  const target = pick(await appContainers());
  if (!target) throw new Error('aucun conteneur applicatif à redémarrer');
  const name = nameOf(target);
  activeFaults.add(`redémarrage de ${name}`);
  log(`chaos : redémarrage (SIGTERM) de ${name}`);
  try {
    await docker('POST', `/containers/${target.Id}/restart?t=10`);
  } finally {
    activeFaults.delete(`redémarrage de ${name}`);
  }
  return name;
}

/** SIGKILL, puis relance après `downSeconds`. */
export async function killRandomService(downSeconds: number): Promise<string> {
  const target = pick(await appContainers());
  if (!target) throw new Error('aucun conteneur applicatif à tuer');
  const name = nameOf(target);
  activeFaults.add(`${name} tué`);
  log(`chaos : SIGKILL sur ${name}, relance dans ${downSeconds} s`);
  await docker('POST', `/containers/${target.Id}/kill?signal=SIGKILL`);
  await sleep(downSeconds * 1000);
  await docker('POST', `/containers/${target.Id}/start`);
  activeFaults.delete(`${name} tué`);
  return name;
}

/** Arrête un composant d'infrastructure (label `quinze.infra=<kind>`) pendant `seconds`. */
export async function stopInfra(kind: string, seconds: number): Promise<string> {
  const targets = (await projectContainers()).filter((c) => c.Labels['quinze.infra'] === kind);
  if (targets.length === 0) throw new Error(`aucun conteneur avec le label quinze.infra=${kind}`);
  activeFaults.add(`${kind} arrêté`);
  log(`chaos : arrêt de ${kind} pendant ${seconds} s`);
  for (const t of targets) await docker('POST', `/containers/${t.Id}/stop?t=0`);
  await sleep(seconds * 1000);
  for (const t of targets) await docker('POST', `/containers/${t.Id}/start`);
  activeFaults.delete(`${kind} arrêté`);
  return kind;
}
