// Vérificateur : compare /audit, les déclarations des clients k6, le grand livre des partenaires
// et les flux SSE observés ; produit les invariants et les métriques du rapport.
import { config } from './config.ts';
import { doubleCharges, ledger } from './partners.ts';
import { isPeak, measuredAttempts, run } from './run-state.ts';
import { percentile, sleep } from './util.ts';

interface AuditOrder {
  orderId: string;
  idempotencyKey: string;
  status: string;
  restaurantId?: string;
  payments: { paymentId: string; status: string }[];
  statusHistory: { status: string; at: string }[];
}

const STATUS_RANK: Record<string, number> = {
  payment_pending: 0,
  paid: 1,
  in_kitchen: 2,
  ready: 3,
  picked_up: 4,
  delivered: 5,
  cancelled: 6,
};
const TERMINAL = new Set(['delivered', 'cancelled']);

/** Vrai si la suite de statuts recule, ou change après un statut terminal. */
function regresses(statuses: string[]): boolean {
  for (let i = 1; i < statuses.length; i++) {
    const previous = statuses[i - 1]!;
    const current = statuses[i]!;
    if (current === previous) continue;
    if (TERMINAL.has(previous)) return true;
    if (current !== 'cancelled' && (STATUS_RANK[current] ?? 0) < (STATUS_RANK[previous] ?? 0)) return true;
  }
  return false;
}

const AUDIT_ATTEMPTS = 6;

/** Une page d'audit, avec nouvelles tentatives : un système encore chargé peut échouer ponctuellement. */
async function readAuditPage(cursor: string | undefined, retries: { count: number }) {
  const url = `${config.systemUrl}/audit?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  let lastError = '';
  for (let attempt = 0; attempt < AUDIT_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      retries.count++;
      await sleep(2000 * 2 ** (attempt - 1));
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (response.ok) return (await response.json()) as { orders: AuditOrder[]; nextCursor?: string };
      lastError = `/audit a répondu ${response.status}`;
    } catch (err) {
      lastError = `/audit injoignable (${(err as Error).message})`;
    }
  }
  throw new Error(`${lastError}, après ${AUDIT_ATTEMPTS} tentatives`);
}

async function readAudit(retries: { count: number }): Promise<AuditOrder[]> {
  const orders: AuditOrder[] = [];
  let cursor: string | undefined;
  do {
    const page = await readAuditPage(cursor, retries);
    orders.push(...page.orders);
    cursor = page.nextCursor;
  } while (cursor);
  return orders;
}

export interface InvariantResult {
  id: number;
  name: string;
  violations: number;
  examples: string[];
}

export async function verify() {
  let audit: AuditOrder[] = [];
  let auditError: string | undefined;
  const auditRetries = { count: 0 };
  try {
    audit = await readAudit(auditRetries);
  } catch (err) {
    auditError = (err as Error).message;
  }
  const byId = new Map(audit.map((o) => [o.orderId, o]));
  const examples = (list: string[]) => list.slice(0, 5);

  // 1. Double débit : par commande (grand livre du PSP) et par intention du client (Idempotency-Key).
  const charged = new Set<string>();
  for (const p of ledger.paymentsById.values()) if (p.status === 'succeeded') charged.add(p.orderId);
  const chargedOrdersByKey = new Map<string, string[]>();
  for (const order of audit) {
    if (!charged.has(order.orderId)) continue;
    const list = chargedOrdersByKey.get(order.idempotencyKey) ?? [];
    list.push(order.orderId);
    chargedOrdersByKey.set(order.idempotencyKey, list);
  }
  const doubleByOrder = doubleCharges().map(([id, n]) => `${id} : ${n} paiements réussis non remboursés`);
  const doubleByKey = [...chargedOrdersByKey]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => `clé ${key} : ${ids.length} commandes débitées`);
  const inv1 = [...doubleByOrder, ...doubleByKey];

  // 2. Aucune commande payée perdue ; toute commande acceptée figure dans /audit.
  const inv2: string[] = [];
  if (auditError) inv2.push(`audit illisible : ${auditError}`);
  for (const id of run.acceptedIds) if (!byId.has(id) && !auditError) inv2.push(`${id} acceptée mais absente de /audit`);
  for (const orderId of charged) {
    const order = byId.get(orderId);
    if (!order) {
      if (!auditError) inv2.push(`${orderId} débitée mais absente de /audit`);
    } else if (order.status === 'cancelled') {
      inv2.push(`${orderId} annulée sans remboursement`);
    } else if (order.status !== 'delivered') {
      inv2.push(`${orderId} payée, encore « ${order.status} » à la fin`);
    }
  }

  // 3 et 4. Vus en direct par les livreurs et les restaurants.
  const inv3 = ledger.violations.filter((v) => v.invariant === 'courier_busy').map((v) => v.detail);
  const inv4 = ledger.violations.filter((v) => v.invariant === 'kitchen_full').map((v) => v.detail);

  // 5. Statut qui recule : historique de l'audit et flux SSE observés.
  const inv5: string[] = [];
  for (const order of audit) {
    if (regresses(order.statusHistory.map((h) => h.status))) {
      inv5.push(`${order.orderId} (audit) : ${order.statusHistory.map((h) => h.status).join(' → ')}`);
    }
  }
  for (const [orderId, events] of run.sse) {
    if (regresses(events.map((e) => e.status))) {
      inv5.push(`${orderId} (SSE) : ${events.map((e) => e.status).join(' → ')}`);
    }
  }

  const invariants: InvariantResult[] = [
    { id: 1, name: 'Jamais de double débit', violations: inv1.length, examples: examples(inv1) },
    { id: 2, name: 'Aucune commande payée perdue', violations: inv2.length, examples: examples(inv2) },
    { id: 3, name: 'Jamais un livreur sur deux courses', violations: inv3.length, examples: examples(inv3) },
    { id: 4, name: 'Capacité cuisine jamais dépassée', violations: inv4.length, examples: examples(inv4) },
    { id: 5, name: 'Un statut ne recule jamais', violations: inv5.length, examples: examples(inv5) },
  ];

  // --- Métriques ---

  const all = measuredAttempts().map((a) => a.ms);
  const peak = measuredAttempts(isPeak).map((a) => a.ms);
  const refusals = measuredAttempts((a) => a.status === 503 || a.status === 429);
  const accepted = run.records.filter((r) => r.outcome === 'accepted');

  const deliveryTimes: number[] = [];
  for (const record of accepted) {
    const deliveredAt = record.orderId ? ledger.deliveredAt.get(record.orderId) : undefined;
    if (deliveredAt) deliveryTimes.push((deliveredAt - record.attempts[0]!.at) / 1000);
  }

  const freshness: number[] = [];
  for (const [orderId, events] of run.sse) {
    for (const { status, t } of events) {
      const ack = ledger.webhookAcks.get(`${orderId}:${status}`);
      if (ack !== undefined) freshness.push(Math.max(0, t - ack));
    }
  }

  const finalStatuses = { delivered: 0, cancelled: 0, inProgress: 0 };
  for (const id of run.acceptedIds) {
    const status = byId.get(id)?.status;
    if (status === 'delivered') finalStatuses.delivered++;
    else if (status === 'cancelled') finalStatuses.cancelled++;
    else finalStatuses.inProgress++;
  }

  return {
    invariants,
    auditError,
    auditRetries: auditRetries.count,
    metrics: {
      clients: {
        total: run.records.length,
        accepted: accepted.length,
        shed: run.records.filter((r) => r.outcome === 'shed').length,
        failed: run.records.filter((r) => r.outcome === 'failed').length,
        rejected: run.records.filter((r) => r.outcome === 'rejected').length,
      },
      postOrdersMs: {
        all: { p50: percentile(all, 50), p95: percentile(all, 95), p99: percentile(all, 99) },
        peak: { p50: percentile(peak, 50), p95: percentile(peak, 95), p99: percentile(peak, 99) },
      },
      refusals: { total: refusals.length, fast: refusals.filter((a) => a.ms < 100).length },
      orders: { ...finalStatuses, deliveredByPartners: ledger.deliveredAt.size },
      deliverySeconds: { p50: percentile(deliveryTimes, 50), p95: percentile(deliveryTimes, 95) },
      sseFreshnessMs: { samples: freshness.length, p50: percentile(freshness, 50), p95: percentile(freshness, 95) },
      sseObservedOrders: run.sse.size,
    },
  };
}
