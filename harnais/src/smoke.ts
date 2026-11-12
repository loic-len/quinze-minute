// Harnais v0 : test de fumée. Charge le monde, passe quelques commandes à faible débit,
// attend qu'elles aboutissent puis vérifie l'audit et le grand livre des partenaires.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const SYSTEM_URL = process.env.SYSTEM_URL ?? 'http://localhost:8080';
const HARNESS_URL = process.env.HARNESS_URL ?? 'http://localhost:9000';
const ORDERS = Number(process.env.ORDERS ?? 8);
const SPACING_MS = Number(process.env.SPACING_MS ?? 750);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 120_000);
const WORLD_FILE = process.env.WORLD ?? new URL('../mondes/smoke.json', import.meta.url).pathname;

const STATUS_ORDER = ['payment_pending', 'paid', 'in_kitchen', 'ready', 'picked_up', 'delivered'];
const TERMINAL = new Set(['delivered', 'cancelled']);

interface World {
  restaurants: {
    restaurantId: string;
    location: { lat: number; lng: number };
    menu: { menuItemId: string }[];
  }[];
}

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`${ok ? '  ok ' : '  KO '} ${message}`);
  if (!ok) failures.push(message);
};

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

async function getJson(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${url} : ${response.status}`);
  return response.json();
}

/** Lit un flux SSE jusqu'à sa fermeture (ou l'expiration), en gardant les événements `status`. */
async function collectStatuses(orderId: string): Promise<string[]> {
  const statuses: string[] = [];
  try {
    const response = await fetch(`${SYSTEM_URL}/orders/${orderId}/events`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok || !response.body) return statuses;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let separator: number;
      while ((separator = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event === 'status' && data) statuses.push(JSON.parse(data).status);
      }
    }
  } catch {
    // flux interrompu : on garde ce qu'on a reçu
  }
  return statuses;
}

// ---------------------------------------------------------------------------

console.log(`Test de fumée : ${ORDERS} commandes vers ${SYSTEM_URL}`);
const world: World = JSON.parse(await readFile(WORLD_FILE, 'utf8'));

console.log('\n1. Chargement du monde');
check((await post(`${HARNESS_URL}/_harness/world`, world)).status === 204, 'partenaires prêts');
check((await post(`${SYSTEM_URL}/admin/world`, world)).status === 204, 'POST /admin/world → 204');

let ready = false;
for (let i = 0; i < 30 && !ready; i++) {
  ready = await fetch(`${SYSTEM_URL}/health/ready`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!ready) await sleep(1000);
}
check(ready, 'GET /health/ready → 200');

console.log('\n2. Commandes');
const orderIds: string[] = [];
let firstStream: Promise<string[]> | undefined;
for (let i = 0; i < ORDERS; i++) {
  const restaurant = world.restaurants[i % world.restaurants.length]!;
  const response = await post(
    `${SYSTEM_URL}/orders`,
    {
      customerId: `client-${i}`,
      restaurantId: restaurant.restaurantId,
      items: [{ menuItemId: restaurant.menu[0]!.menuItemId, quantity: 1 + (i % 3) }],
      deliveryLocation: {
        lat: restaurant.location.lat + 0.004 * Math.cos(i),
        lng: restaurant.location.lng + 0.004 * Math.sin(i),
      },
    },
    { 'idempotency-key': randomUUID() },
  );
  if (response.status === 201) {
    const order = (await response.json()) as { orderId: string };
    orderIds.push(order.orderId);
    firstStream ??= collectStatuses(order.orderId);
  } else {
    check(false, `POST /orders → ${response.status}`);
  }
  await sleep(SPACING_MS);
}
check(orderIds.length === ORDERS, `${orderIds.length}/${ORDERS} commandes créées (201)`);

console.log('\n3. Attente de la fin des commandes');
const deadline = Date.now() + TIMEOUT_MS;
let finals = new Map<string, string>();
while (Date.now() < deadline) {
  finals = new Map();
  for (const id of orderIds) {
    const order = await getJson(`${SYSTEM_URL}/orders/${id}`).catch(() => undefined);
    if (order && TERMINAL.has(order.status)) finals.set(id, order.status);
  }
  if (finals.size === orderIds.length) break;
  await sleep(2000);
}
check(finals.size === orderIds.length, `${finals.size}/${orderIds.length} commandes terminées`);
const delivered = [...finals.values()].filter((s) => s === 'delivered').length;
console.log(`     ${delivered} livrées, ${finals.size - delivered} annulées`);

console.log('\n4. Suivi en direct (SSE) de la première commande');
const streamed = firstStream ? await firstStream : [];
console.log(`     reçu : ${streamed.join(' → ') || '(rien)'}`);
check(streamed.length > 1, 'plusieurs statuts reçus en SSE');
check(TERMINAL.has(streamed.at(-1) ?? ''), 'le flux finit sur un statut terminal');

console.log('\n5. Audit et invariants');
const audited: any[] = [];
let cursor: string | undefined;
do {
  const page = await getJson(`${SYSTEM_URL}/audit${cursor ? `?cursor=${cursor}` : ''}`);
  audited.push(...page.orders);
  cursor = page.nextCursor;
} while (cursor);
check(audited.length === orderIds.length, `/audit liste ${audited.length} commandes`);

const regressions = audited.filter((o) => {
  const ranks = o.statusHistory
    .map((h: { status: string }) => h.status)
    .filter((s: string) => s !== 'cancelled')
    .map((s: string) => STATUS_ORDER.indexOf(s));
  return ranks.some((rank: number, i: number) => i > 0 && rank < ranks[i - 1]);
});
check(regressions.length === 0, 'aucun statut qui recule');

const ledger = await getJson(`${HARNESS_URL}/_harness/ledger`);
for (const v of ledger.violations) console.log(`     violation : ${v.invariant} — ${v.detail}`);
check(ledger.violations.length === 0, 'aucune violation vue par les partenaires');

const unrefunded = audited.filter(
  (o) =>
    o.status === 'cancelled' &&
    ledger.payments.some((p: any) => p.orderId === o.orderId && p.status === 'succeeded'),
);
check(unrefunded.length === 0, 'toute commande annulée est remboursée');

console.log(failures.length === 0 ? '\nSMOKE OK' : `\nSMOKE KO (${failures.length} échec(s))`);
process.exit(failures.length === 0 ? 0 : 1);
