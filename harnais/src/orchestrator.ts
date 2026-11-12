// Orchestrateur d'un passage : monde, k6, chronologie du chaos, période de grâce, vérification, rapport.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.ts';
import {
  dockerAvailable,
  killRandomService,
  knobs,
  resetChaos,
  restartRandomService,
  sampleCpu,
  stackResources,
  stopInfra,
} from './chaos.ts';
import { loadPartnersWorld } from './partners.ts';
import { buildReport, writeReport } from './report.ts';
import { recordCpu, resetRun, run } from './run-state.ts';
import type { ChaosEvent, Scenario } from './scenarios.ts';
import { LOW, PEAK, scenarios } from './scenarios.ts';
import { log, sleep } from './util.ts';
import { verify } from './verifier.ts';
import { generateWorld, worldFingerprint } from './world.ts';
import type { World } from './world.ts';

const K6_SCRIPT = new URL('../k6/match.js', import.meta.url).pathname;

let timers: NodeJS.Timeout[] = [];

export function isRunning() {
  return ['preparing', 'running', 'grace', 'verifying'].includes(run.status);
}

async function loadScenario(name: string, peakRate?: number): Promise<Scenario> {
  const base = scenarios[name];
  if (!base) throw new Error(`scénario inconnu : ${name} (connus : ${Object.keys(scenarios).join(', ')})`);
  const scenario: Scenario = { ...base, chaos: [...base.chaos] };
  if (peakRate !== undefined) {
    // Calibrage : tous les débits au-dessus du débit bas suivent le nouveau pic.
    const factor = peakRate / PEAK;
    scenario.phases = base.phases.map((p) => (p.rate > LOW ? { ...p, rate: p.rate * factor } : p));
  }
  if (name === 'game-day' && config.surpriseFile) {
    const surprise = JSON.parse(await readFile(config.surpriseFile, 'utf8')) as ChaosEvent[];
    scenario.chaos.push(...surprise);
    log(`panne surprise chargée : ${surprise.length} événement(s)`);
  }
  return scenario;
}

async function loadSystemWorld(world: World) {
  const response = await fetch(`${config.systemUrl}/admin/world`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(world),
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status !== 204) throw new Error(`POST /admin/world a répondu ${response.status}`);
  for (let i = 0; i < 60; i++) {
    const ready = await fetch(`${config.systemUrl}/health/ready`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ready) return;
    await sleep(1000);
  }
  throw new Error('GET /health/ready ne répond pas 200 après 60 s');
}

async function applyChaos(event: ChaosEvent, slowRestaurantId: string) {
  const entry: { at: number; label: string; error?: string } = { at: event.at, label: event.label };
  run.chaosLog.push(entry);
  log(`chaos à ${event.at} s : ${event.label}`);
  try {
    switch (event.action) {
      case 'restart':
        entry.label += ` → ${await restartRandomService()}`;
        break;
      case 'kill':
        entry.label += ` → ${await killRandomService(event.downSeconds)}`;
        break;
      case 'stopInfra':
        await stopInfra(event.infra, event.seconds);
        break;
      case 'psp':
        knobs.psp = event.mode;
        break;
      case 'slowRestaurant':
        knobs.slowRestaurantId = event.on ? slowRestaurantId : undefined;
        break;
    }
  } catch (err) {
    entry.error = (err as Error).message;
    log(`chaos « ${event.label} » non joué : ${entry.error}`);
  }
}

function runK6(scenario: Scenario, files: { config: string; world: string; summary: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('k6', ['run', '--quiet', '--no-usage-report', K6_SCRIPT], {
      env: {
        ...process.env,
        CONFIG_FILE: files.config,
        WORLD_FILE: files.world,
        SUMMARY_FILE: files.summary,
        SYSTEM_URL: config.systemUrl,
        HARNESS_URL: config.selfUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => process.stdout.write(`[k6] ${d}`));
    child.stderr.on('data', (d) => process.stdout.write(`[k6] ${d}`));
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
    log(`k6 lancé pour ${scenario.title}`);
  });
}

export async function startRun(name: string, peakRate?: number) {
  if (isRunning()) throw new Error('un passage est déjà en cours');
  if (peakRate !== undefined && !(peakRate > 0)) throw new Error('peakRate doit être un nombre positif');
  const scenario = await loadScenario(name, peakRate);
  resetRun(scenario);
  void execute(scenario);
}

async function execute(scenario: Scenario) {
  try {
    resetChaos();
    const world = generateWorld(scenario.world.seed, scenario.world.restaurants, scenario.world.couriers);
    const fingerprint = worldFingerprint(world);
    const slowRestaurantId = world.restaurants[scenario.world.seed % world.restaurants.length]!.restaurantId;
    const docker = await dockerAvailable();
    if (!docker) log('socket Docker indisponible : les redémarrages et arrêts ne seront pas joués');
    const resources = docker ? await stackResources() : undefined;
    if (resources) log(`ressources de la stack : ${resources.cpus} CPU, ${resources.memoryGb} Go`);

    loadPartnersWorld(world);
    await loadSystemWorld(world);

    const files = {
      config: join(tmpdir(), 'quinze-k6-config.json'),
      world: join(tmpdir(), 'quinze-world.json'),
      summary: join(tmpdir(), 'quinze-k6-summary.json'),
    };
    await writeFile(
      files.config,
      JSON.stringify({
        startRate: scenario.phases[0]!.rate,
        stages: scenario.phases.map((p) => ({ duration: `${p.seconds}s`, target: p.rate })),
        clientCutRate: scenario.traps.clientCutRate,
      }),
    );
    await writeFile(files.world, JSON.stringify(world));

    knobs.webhookDuplicateRate = scenario.traps.webhookDuplicateRate;
    knobs.readyAfterPickupRate = scenario.traps.readyAfterPickupRate;
    knobs.pspLoseResponseRate = scenario.traps.pspLoseResponseRate;
    if (scenario.slowRestaurantFromStart) knobs.slowRestaurantId = slowRestaurantId;

    run.status = 'running';
    run.startedAt = Date.now();
    timers = scenario.chaos.map((event) =>
      setTimeout(() => void applyChaos(event, slowRestaurantId), event.at * 1000),
    );
    if (docker) {
      let sampling = false;
      timers.push(
        setInterval(() => {
          if (sampling) return;
          sampling = true;
          sampleCpu()
            .then(recordCpu)
            .catch(() => {})
            .finally(() => (sampling = false));
        }, 5000),
      );
    }

    const exitCode = await runK6(scenario, files);
    if (exitCode !== 0) log(`k6 s'est terminé avec le code ${exitCode}`);

    run.status = 'grace';
    log(`période de grâce : ${scenario.graceSeconds} s`);
    await sleep(scenario.graceSeconds * 1000);

    timers.forEach((t) => clearTimeout(t));
    run.status = 'verifying';
    log('vérification');
    const verification = await verify();
    run.report = buildReport(verification, {
      worldFingerprint: fingerprint,
      slowRestaurantId,
      dockerAvailable: docker,
      resources,
      peakRate: Math.max(...scenario.phases.map((p) => p.rate)),
    });
    const path = await writeReport(run.report);
    if (path) run.report.fichier = path;
    run.status = 'done';
    log(`terminé : ${run.report.passed ? 'PALIER FRANCHI' : 'palier non franchi'}, score ${run.report.score}`);
  } catch (err) {
    run.error = (err as Error).message;
    run.status = 'error';
    log(`passage interrompu : ${run.error}`);
  } finally {
    timers.forEach(clearTimeout);
    timers = [];
    resetChaos();
  }
}
