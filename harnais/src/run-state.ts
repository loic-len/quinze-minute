// État du passage en cours : ce que les clients k6 déclarent, la chronologie, les flux SSE observés.
import { activeFaults } from './chaos.ts';
import { ledger } from './partners.ts';
import type { Phase, Scenario } from './scenarios.ts';
import { PEAK_PHASES } from './scenarios.ts';
import { percentile } from './util.ts';

export interface Attempt {
  status: number;
  ms: number;
  at: number;
  cut: boolean;
}

export interface ClientRecord {
  key: string;
  orderId: string | null;
  outcome: 'accepted' | 'rejected' | 'shed' | 'failed';
  attempts: Attempt[];
  restaurantId: string;
}

export interface Report {
  [key: string]: unknown;
  passed: boolean;
  score: number;
}

export const run = {
  status: 'idle' as 'idle' | 'preparing' | 'running' | 'grace' | 'verifying' | 'done' | 'error',
  scenario: undefined as Scenario | undefined,
  startedAt: 0,
  records: [] as ClientRecord[],
  acceptedIds: new Set<string>(),
  /** orderId → statuts reçus en SSE, avec l'instant de réception. */
  sse: new Map<string, { status: string; t: number }[]>(),
  chaosLog: [] as { at: number; label: string; error?: string }[],
  error: undefined as string | undefined,
  report: undefined as Report | undefined,
  /** Relevés CPU par conteneur pendant le passage. */
  cpu: new Map<string, { sum: number; count: number; max: number; limitCores?: number }>(),
};

export function resetRun(scenario: Scenario) {
  run.status = 'preparing';
  run.scenario = scenario;
  run.startedAt = 0;
  run.records = [];
  run.acceptedIds = new Set();
  run.sse = new Map();
  run.chaosLog = [];
  run.error = undefined;
  run.report = undefined;
  run.cpu = new Map();
}

export function recordCpu(samples: { name: string; cores: number; limitCores: number | undefined }[]) {
  for (const { name, cores, limitCores } of samples) {
    const entry = run.cpu.get(name) ?? { sum: 0, count: 0, max: 0, limitCores };
    entry.sum += cores;
    entry.count++;
    entry.max = Math.max(entry.max, cores);
    entry.limitCores = limitCores;
    run.cpu.set(name, entry);
  }
}

/** Synthèse CPU pour le rapport, du conteneur le plus proche de sa limite au moins chargé. */
export function cpuSummary() {
  return [...run.cpu]
    .map(([container, e]) => ({
      container,
      meanCores: Number((e.sum / Math.max(1, e.count)).toFixed(2)),
      maxCores: Number(e.max.toFixed(2)),
      limitCores: e.limitCores,
      maxOfLimit: e.limitCores ? Number((e.max / e.limitCores).toFixed(2)) : undefined,
    }))
    .sort((a, b) => (b.maxOfLimit ?? 0) - (a.maxOfLimit ?? 0));
}

/** Phase en cours à l'instant `t` (ms depuis le début), ou `grâce` après la dernière. */
export function phaseAt(t: number): Phase | undefined {
  let end = 0;
  for (const phase of run.scenario?.phases ?? []) {
    end += phase.seconds * 1000;
    if (t < end) return phase;
  }
  return undefined;
}

export const totalSeconds = () =>
  (run.scenario?.phases.reduce((s, p) => s + p.seconds, 0) ?? 0) + (run.scenario?.graceSeconds ?? 0);

/** Tentatives mesurables (hors coupures volontaires du client). */
export function measuredAttempts(filter?: (a: Attempt) => boolean): Attempt[] {
  const out: Attempt[] = [];
  for (const record of run.records) {
    for (const attempt of record.attempts) {
      if (!attempt.cut && (!filter || filter(attempt))) out.push(attempt);
    }
  }
  return out;
}

export const isPeak = (a: Attempt) => PEAK_PHASES.has(phaseAt(a.at - run.startedAt)?.name ?? '');

/** Instantané pour la page live et la CLI. */
export function snapshot() {
  const now = Date.now();
  const elapsed = run.startedAt ? (now - run.startedAt) / 1000 : 0;
  const seconds = Math.max(0, Math.floor(elapsed));

  const demand = new Array<number>(seconds + 1).fill(0);
  const accepted = new Array<number>(seconds + 1).fill(0);
  for (const record of run.records) {
    const first = record.attempts[0];
    if (!first) continue;
    const s = Math.floor((first.at - run.startedAt) / 1000);
    if (s >= 0 && s <= seconds) {
      demand[s]!++;
      if (record.outcome === 'accepted') accepted[s]!++;
    }
  }
  const recent = measuredAttempts((a) => now - a.at < 10_000).map((a) => a.ms);
  const count = (o: ClientRecord['outcome']) => run.records.filter((r) => r.outcome === o).length;

  return {
    status: run.status,
    scenario: run.scenario && { name: run.scenario.name, title: run.scenario.title },
    phase: run.status === 'grace' ? 'Période de grâce' : phaseAt(elapsed * 1000)?.label,
    elapsed: Math.round(elapsed),
    total: totalSeconds(),
    series: { demand, accepted },
    p99Last10s: percentile(recent, 99),
    totals: {
      clients: run.records.length,
      accepted: count('accepted'),
      shed: count('shed'),
      failed: count('failed'),
      rejected: count('rejected'),
      delivered: ledger.deliveredAt.size,
    },
    violations: ledger.violations.length,
    faults: [...activeFaults],
    chaosLog: run.chaosLog,
    error: run.error,
    report: run.report,
  };
}
