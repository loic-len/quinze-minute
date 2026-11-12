// Les paliers et le game day. Débits et seuils calibrés le 2026-11-10 : pic à 12 commandes/s,
// qu'une solution complète tient avec 1,7× de marge.

export interface Phase {
  name: string;
  /** Libellé affiché sur la page live. */
  label: string;
  seconds: number;
  /** Débit (commandes/s) atteint à la fin de la phase ; montée linéaire depuis la phase précédente. */
  rate: number;
}

export type ChaosAction =
  | { action: 'restart' }
  | { action: 'kill'; downSeconds: number }
  | { action: 'stopInfra'; infra: string; seconds: number }
  | { action: 'psp'; mode: 'ok' | 'unavailable' | 'hang' }
  | { action: 'slowRestaurant'; on: boolean };

export type ChaosEvent = ChaosAction & { at: number; label: string };

export interface Scenario {
  name: string;
  title: string;
  world: { seed: number; restaurants: number; couriers: number };
  phases: Phase[];
  graceSeconds: number;
  /** Pièges actifs pendant tout le scénario. */
  traps: {
    webhookDuplicateRate: number;
    readyAfterPickupRate: number;
    pspLoseResponseRate: number;
    /** Part des tentatives où le client coupe avant la réponse (puis retente avec la même clé). */
    clientCutRate: number;
  };
  /** Le restaurant lent (palier 2 et suivants) est désigné de façon déterministe à partir de la graine. */
  slowRestaurantFromStart: boolean;
  chaos: ChaosEvent[];
  sseSampleRate: number;
  criteria: {
    /** p95 maximal de POST /orders pendant la mi-temps (ms). Le p99, plus instable, départage le classement. */
    p95PeakMs: number;
    /** Part minimale des commandes acceptées qui finissent livrées ou proprement annulées. */
    minCompletedRatio: number;
    /** Le bon restaurant lent doit être désigné. */
    requireDiagnosis: boolean;
    /** Invariants dont une violation fait échouer le palier (et annule le score). Les autres sont affichés. */
    blockingInvariants: number[];
  };
}

export const LOW = 2;
export const PEAK = 12;
const SEED = 2026;
const WORLD = { seed: SEED, restaurants: 40, couriers: 300 };

const TP_PHASES: Phase[] = [
  { name: 'avant-match', label: 'Avant-match', seconds: 60, rate: LOW },
  { name: 'coup-de-sifflet', label: 'Coup de sifflet', seconds: 30, rate: PEAK },
  { name: 'mi-temps', label: 'Mi-temps', seconds: 120, rate: PEAK },
  { name: 'reprise', label: 'Reprise', seconds: 60, rate: LOW },
];

const NO_TRAPS = { webhookDuplicateRate: 0, readyAfterPickupRate: 0, pspLoseResponseRate: 0, clientCutRate: 0 };
const TRAPS = { webhookDuplicateRate: 0.3, readyAfterPickupRate: 0.3, pspLoseResponseRate: 0.05, clientCutRate: 0.05 };

const RESTART_AT_PEAK: ChaosEvent = { at: 150, action: 'restart', label: 'Un service redémarre (SIGTERM)' };

const PALIER_4_CHAOS: ChaosEvent[] = [
  { at: 60, action: 'slowRestaurant', on: true, label: 'Un restaurant devient lent' },
  { at: 100, action: 'psp', mode: 'unavailable', label: 'PSP en panne (503)' },
  { at: 130, action: 'stopInfra', infra: 'redis', seconds: 30, label: 'Redis arrêté 30 s' },
  { at: 160, action: 'psp', mode: 'hang', label: 'PSP ne répond plus' },
  { at: 170, action: 'kill', downSeconds: 10, label: 'Un service tué (SIGKILL)' },
  { at: 220, action: 'psp', mode: 'ok', label: 'PSP rétabli' },
  { at: 240, action: 'slowRestaurant', on: false, label: 'Restaurant rétabli' },
];

export const scenarios: Record<string, Scenario> = {
  'palier-1': {
    name: 'palier-1',
    title: 'Palier 1 · Charge',
    world: WORLD,
    phases: TP_PHASES,
    graceSeconds: 60,
    traps: NO_TRAPS,
    slowRestaurantFromStart: false,
    chaos: [RESTART_AT_PEAK],
    sseSampleRate: 0.05,
    criteria: { p95PeakMs: 1000, minCompletedRatio: 0.95, requireDiagnosis: false, blockingInvariants: [2] },
  },
  'palier-2': {
    name: 'palier-2',
    title: 'Palier 2 · Lenteur cachée',
    world: WORLD,
    phases: TP_PHASES,
    graceSeconds: 60,
    traps: NO_TRAPS,
    slowRestaurantFromStart: true,
    chaos: [RESTART_AT_PEAK],
    sseSampleRate: 0.05,
    criteria: { p95PeakMs: 1000, minCompletedRatio: 0.95, requireDiagnosis: true, blockingInvariants: [2] },
  },
  'palier-3': {
    name: 'palier-3',
    title: 'Palier 3 · Doublons et désordre',
    world: WORLD,
    phases: TP_PHASES,
    graceSeconds: 60,
    traps: TRAPS,
    slowRestaurantFromStart: false,
    chaos: [RESTART_AT_PEAK],
    sseSampleRate: 0.1,
    criteria: { p95PeakMs: 1000, minCompletedRatio: 0.95, requireDiagnosis: false, blockingInvariants: [1, 2, 3, 4, 5] },
  },
  'palier-4': {
    name: 'palier-4',
    title: 'Palier 4 · Chaos',
    world: WORLD,
    phases: TP_PHASES,
    graceSeconds: 90,
    traps: TRAPS,
    slowRestaurantFromStart: false,
    chaos: PALIER_4_CHAOS,
    sseSampleRate: 0.05,
    criteria: { p95PeakMs: 1500, minCompletedRatio: 0.9, requireDiagnosis: false, blockingInvariants: [1, 2, 3, 4, 5] },
  },
  'game-day': {
    name: 'game-day',
    title: 'Game day · France–Espagne',
    world: { seed: SEED + 1, restaurants: 40, couriers: 300 },
    phases: [
      { name: 'avant-match', label: 'Avant-match', seconds: 180, rate: LOW },
      { name: 'coup-de-sifflet', label: 'Coup de sifflet', seconds: 60, rate: PEAK },
      { name: 'rush', label: 'Mi-temps · le rush', seconds: 300, rate: PEAK },
      { name: 'mi-temps', label: 'Mi-temps', seconds: 540, rate: PEAK / 2 },
      { name: 'reprise', label: 'Reprise', seconds: 120, rate: LOW },
    ],
    graceSeconds: 180,
    traps: TRAPS,
    slowRestaurantFromStart: false,
    chaos: [
      { at: 300, action: 'restart', label: 'Un service redémarre (SIGTERM)' },
      { at: 400, action: 'slowRestaurant', on: true, label: 'Un restaurant devient lent' },
      { at: 500, action: 'psp', mode: 'unavailable', label: 'PSP en panne (503)' },
      { at: 560, action: 'psp', mode: 'hang', label: 'PSP ne répond plus' },
      { at: 620, action: 'psp', mode: 'ok', label: 'PSP rétabli' },
      { at: 700, action: 'stopInfra', infra: 'redis', seconds: 30, label: 'Redis arrêté 30 s' },
      { at: 800, action: 'kill', downSeconds: 10, label: 'Un service tué (SIGKILL)' },
      { at: 900, action: 'slowRestaurant', on: false, label: 'Restaurant rétabli' },
    ],
    sseSampleRate: 0.05,
    criteria: { p95PeakMs: 1500, minCompletedRatio: 0.9, requireDiagnosis: false, blockingInvariants: [1, 2, 3, 4, 5] },
  },
};

/** Les phases de la mi-temps, où l'on mesure le p99. */
export const PEAK_PHASES = new Set(['mi-temps', 'rush']);
