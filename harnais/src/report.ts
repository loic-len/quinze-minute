// Critères du palier, score et rapport signé.
import { createHmac } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, VERSION } from './config.ts';
import { ledger } from './partners.ts';
import type { Report } from './run-state.ts';
import { cpuSummary, run } from './run-state.ts';
import type { verify } from './verifier.ts';
import { log } from './util.ts';

type Verification = Awaited<ReturnType<typeof verify>>;

interface Criterion {
  name: string;
  ok: boolean;
  value: string;
  threshold: string;
}

export function buildReport(
  verification: Verification,
  context: {
    worldFingerprint: string;
    slowRestaurantId?: string;
    dockerAvailable: boolean;
    resources?: { cpus: number; memoryGb: number; unlimited: string[] };
    peakRate: number;
  },
): Report {
  const scenario = run.scenario!;
  const { metrics, invariants } = verification;
  const criteria: Criterion[] = [];

  const blocking = new Set(scenario.criteria.blockingInvariants);
  const blockingViolations = invariants
    .filter((i) => blocking.has(i.id))
    .reduce((s, i) => s + i.violations, 0);
  criteria.push({
    name: `Aucune violation des invariants bloquants (${[...blocking].join(', ')})`,
    ok: blockingViolations === 0,
    value: String(blockingViolations),
    threshold: '0',
  });

  if (context.resources) {
    const { cpus, memoryGb, unlimited } = context.resources;
    criteria.push({
      name: 'Ressources de la stack dans le budget',
      ok: unlimited.length === 0 && cpus <= config.budget.cpus && memoryGb <= config.budget.memoryGb,
      value: unlimited.length ? `sans limite : ${unlimited.join(', ')}` : `${cpus} CPU, ${memoryGb} Go`,
      threshold: `≤ ${config.budget.cpus} CPU, ≤ ${config.budget.memoryGb} Go`,
    });
  }

  const p95 = metrics.postOrdersMs.peak.p95;
  criteria.push({
    name: 'p95 de POST /orders pendant la mi-temps',
    ok: p95 !== undefined && p95 <= scenario.criteria.p95PeakMs,
    value: p95 === undefined ? '—' : `${p95} ms (p99 : ${metrics.postOrdersMs.peak.p99 ?? '—'} ms)`,
    threshold: `≤ ${scenario.criteria.p95PeakMs} ms`,
  });

  const accepted = metrics.clients.accepted;
  const completed = metrics.orders.delivered + metrics.orders.cancelled;
  const ratio = accepted === 0 ? 0 : completed / accepted;
  criteria.push({
    name: 'Commandes acceptées terminées (livrées ou annulées proprement)',
    ok: accepted > 0 && ratio >= scenario.criteria.minCompletedRatio,
    value: `${(ratio * 100).toFixed(1)} % (${completed}/${accepted})`,
    threshold: `≥ ${(scenario.criteria.minCompletedRatio * 100).toFixed(0)} %`,
  });

  if (scenario.criteria.requireDiagnosis) {
    const designated = ledger.diagnosis?.restaurantId;
    criteria.push({
      name: 'Restaurant lent désigné',
      ok: designated !== undefined && designated === context.slowRestaurantId,
      value: designated ?? 'aucun',
      threshold: 'le bon restaurant',
    });
  }

  const passed = criteria.every((c) => c.ok);
  const score = blockingViolations === 0 ? metrics.orders.delivered : 0;

  const unsigned = {
    harnais: VERSION,
    palier: scenario.name,
    titre: scenario.title,
    startedAt: new Date(run.startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    monde: { ...scenario.world, empreinte: context.worldFingerprint },
    debitPic: context.peakRate,
    ressources: context.resources,
    passed,
    score,
    criteria,
    invariants: invariants.map((i) => ({ ...i, blocking: blocking.has(i.id) })),
    metrics,
    cpu: cpuSummary(),
    chaos: run.chaosLog,
    remarques: [
      ...(context.dockerAvailable ? [] : ['Socket Docker indisponible : redémarrages et arrêts non joués.']),
      ...(verification.auditError ? [`Audit : ${verification.auditError}`] : []),
      ...(verification.auditRetries > 0
        ? [`Audit : ${verification.auditRetries} nouvelle(s) tentative(s) avant de pouvoir le lire.`]
        : []),
    ],
  };
  const signature = createHmac('sha256', config.signingKey).update(JSON.stringify(unsigned)).digest('hex');
  return { ...unsigned, signature };
}

export async function writeReport(report: Report): Promise<string | undefined> {
  const name = `rapport-${String(report.palier)}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  try {
    await mkdir(config.reportDir, { recursive: true });
    const path = join(config.reportDir, name);
    await writeFile(path, JSON.stringify(report, null, 2));
    log(`rapport écrit : ${path}`);
    return path;
  } catch (err) {
    log(`impossible d'écrire le rapport (${(err as Error).message})`);
    return undefined;
  }
}

/** Vérifie la signature d'un rapport (outil enseignant). */
export function checkSignature(report: Record<string, unknown>): boolean {
  const { signature, ...unsigned } = report;
  const expected = createHmac('sha256', config.signingKey).update(JSON.stringify(unsigned)).digest('hex');
  return signature === expected;
}
