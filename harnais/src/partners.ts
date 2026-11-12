// Partenaires simulés (PSP, restaurants, livreurs), conformes à contrat/partenaires.openapi.yaml.
// Chaque partenaire tient son grand livre et enregistre les violations d'invariant qu'il voit.
// Les pièges (doublons, désordre, pannes) sont pilotés par `knobs` (chaos.ts).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from './config.ts';
import { knobs } from './chaos.ts';
import { between, log, problem, scaled, sleep } from './util.ts';
import type { Location, World } from './world.ts';

export interface Payment {
  paymentId: string;
  orderId: string;
  amountCents: number;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
}

export interface Violation {
  invariant: 'double_charge' | 'kitchen_full' | 'courier_busy' | 'lost_order' | 'status_regression';
  detail: string;
  at: string;
}

/** Statut de commande que chaque webhook est censé provoquer (pour mesurer la fraîcheur SSE). */
const STATUS_OF_EVENT: Record<string, string> = {
  'payment.succeeded': 'paid',
  'order.ready': 'ready',
  'order.picked_up': 'picked_up',
  'order.delivered': 'delivered',
};

// ---------------------------------------------------------------------------
// Grand livre (remis à zéro à chaque monde)
// ---------------------------------------------------------------------------

export const ledger = {
  generation: 0,
  restaurants: new Map<string, { location: Location; capacity: number; cooking: Set<string> }>(),
  couriers: new Map<string, { location: Location; busyWith?: string }>(),
  paymentsByKey: new Map<string, Payment>(),
  paymentsById: new Map<string, Payment>(),
  refundsByKey: new Map<string, string>(),
  kitchenAccepted: new Map<string, string>(),
  readyOrders: new Set<string>(),
  readyWaiters: new Map<string, () => void>(),
  violations: [] as Violation[],
  /** `${orderId}:${status}` → instant du premier webhook acquitté. */
  webhookAcks: new Map<string, number>(),
  /** orderId → instant où le système a acquitté `order.delivered`. */
  deliveredAt: new Map<string, number>(),
  /** Dernier restaurant désigné sur /diagnostics/slow-restaurant. */
  diagnosis: undefined as { restaurantId: string; traceId?: string } | undefined,
};

export function loadPartnersWorld(world: World) {
  ledger.generation++;
  ledger.restaurants = new Map(
    world.restaurants.map((r) => [
      r.restaurantId,
      { location: r.location, capacity: r.kitchenCapacity, cooking: new Set<string>() },
    ]),
  );
  ledger.couriers = new Map(world.couriers.map((c) => [c.courierId, { location: { ...c.location } }]));
  ledger.paymentsByKey = new Map();
  ledger.paymentsById = new Map();
  ledger.refundsByKey = new Map();
  ledger.kitchenAccepted = new Map();
  ledger.readyOrders = new Set();
  ledger.readyWaiters = new Map();
  ledger.violations = [];
  ledger.webhookAcks = new Map();
  ledger.deliveredAt = new Map();
  ledger.diagnosis = undefined;
}

export function recordViolation(invariant: Violation['invariant'], detail: string) {
  ledger.violations.push({ invariant, detail, at: new Date().toISOString() });
  log(`VIOLATION ${invariant} : ${detail}`);
}

/** Commandes ayant plus d'un paiement réussi et non remboursé. */
export function doubleCharges(): [string, number][] {
  const succeeded = new Map<string, number>();
  for (const payment of ledger.paymentsById.values()) {
    if (payment.status === 'succeeded') succeeded.set(payment.orderId, (succeeded.get(payment.orderId) ?? 0) + 1);
  }
  return [...succeeded].filter(([, n]) => n > 1);
}

// ---------------------------------------------------------------------------
// Webhooks : au moins une fois, nouvelle tentative faute de 2xx en 5 s, doublons si demandé
// ---------------------------------------------------------------------------

async function send(path: string, event: Record<string, unknown>, world: number): Promise<boolean> {
  for (let attempt = 0; attempt < 8 && world === ledger.generation; attempt++) {
    try {
      const response = await fetch(config.systemUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return true;
    } catch {
      // nouvelle tentative
    }
    await sleep(200 * 2 ** attempt);
  }
  return false;
}

export async function deliver(path: string, body: Record<string, unknown> & { orderId: string; type: string }) {
  const event = { eventId: randomUUID(), occurredAt: new Date().toISOString(), ...body };
  const world = ledger.generation;
  const ok = await send(path, event, world);
  if (ok && world === ledger.generation) {
    const status = STATUS_OF_EVENT[body.type];
    if (status) {
      const key = `${body.orderId}:${status}`;
      if (!ledger.webhookAcks.has(key)) ledger.webhookAcks.set(key, Date.now());
    }
    if (body.type === 'order.delivered' && !ledger.deliveredAt.has(body.orderId)) {
      ledger.deliveredAt.set(body.orderId, Date.now());
    }
  }
  if (Math.random() < knobs.webhookDuplicateRate) {
    const copies = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < copies; i++) {
      setTimeout(() => void send(path, event, world), scaled(between(200, 3000)));
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function pspGate(): Promise<'ok' | 'unavailable'> {
  if (knobs.psp === 'hang') {
    const until = Date.now() + 60_000;
    while (knobs.psp === 'hang' && Date.now() < until) await sleep(500);
    return 'unavailable';
  }
  return knobs.psp === 'unavailable' ? 'unavailable' : 'ok';
}

function waitReady(orderId: string): Promise<void> {
  if (ledger.readyOrders.has(orderId)) return Promise.resolve();
  return new Promise((resolve) => ledger.readyWaiters.set(orderId, resolve));
}

function markReady(orderId: string) {
  ledger.readyOrders.add(orderId);
  ledger.readyWaiters.get(orderId)?.();
  ledger.readyWaiters.delete(orderId);
}

async function moveTo(courier: { location: Location }, target: Location, durationMs: number) {
  const start = { ...courier.location };
  const steps = Math.max(1, Math.round(durationMs / 250));
  for (let i = 1; i <= steps; i++) {
    await sleep(durationMs / steps);
    courier.location = {
      lat: start.lat + ((target.lat - start.lat) * i) / steps,
      lng: start.lng + ((target.lng - start.lng) * i) / steps,
    };
  }
}

async function runDelivery(courierId: string, orderId: string, restaurant: Location, destination: Location) {
  const world = ledger.generation;
  const courier = ledger.couriers.get(courierId)!;
  await moveTo(courier, restaurant, scaled(between(2000, 5000)));
  await waitReady(orderId);
  await sleep(scaled(between(500, 1500))); // remise du sac au livreur
  if (world !== ledger.generation) return;
  await deliver('/webhooks/couriers', { type: 'order.picked_up', courierId, orderId });
  await moveTo(courier, destination, scaled(between(2000, 5000)));
  if (world !== ledger.generation) return;
  courier.busyWith = undefined;
  await deliver('/webhooks/couriers', { type: 'order.delivered', courierId, orderId });
}

export function registerPartners(app: FastifyInstance) {
  // --- PSP ---

  app.post<{ Body: { orderId: string; customerId: string; amountCents: number } }>(
    '/psp/payments',
    async (request, reply) => {
      if ((await pspGate()) === 'unavailable') {
        return reply.header('retry-after', '5').code(503).type('application/problem+json').send({
          type: 'unavailable',
          title: 'PSP indisponible',
          status: 503,
        });
      }
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string') return problem(reply, 422, 'missing_idempotency_key');

      const known = ledger.paymentsByKey.get(key);
      if (known) return reply.code(202).send({ paymentId: known.paymentId, status: known.status });

      const payment: Payment = {
        paymentId: `pay-${randomUUID()}`,
        orderId: request.body.orderId,
        amountCents: request.body.amountCents,
        status: 'pending',
      };
      ledger.paymentsByKey.set(key, payment);
      ledger.paymentsById.set(payment.paymentId, payment);

      const world = ledger.generation;
      setTimeout(() => {
        if (world !== ledger.generation) return;
        payment.status = 'succeeded';
        void deliver('/webhooks/psp', {
          type: 'payment.succeeded',
          paymentId: payment.paymentId,
          orderId: payment.orderId,
          amountCents: payment.amountCents,
        });
      }, scaled(between(100, 500)));

      if (Math.random() < knobs.pspLoseResponseRate) {
        // Le paiement est pris en compte, mais la réponse n'arrive jamais.
        reply.hijack();
        reply.raw.socket?.destroy();
        return;
      }
      return reply.code(202).send({ paymentId: payment.paymentId, status: 'pending' });
    },
  );

  app.post<{ Body: { paymentId: string } }>('/psp/refunds', async (request, reply) => {
    if ((await pspGate()) === 'unavailable') {
      return reply.header('retry-after', '5').code(503).type('application/problem+json').send({
        type: 'unavailable',
        title: 'PSP indisponible',
        status: 503,
      });
    }
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string') return problem(reply, 422, 'missing_idempotency_key');

    const knownRefund = ledger.refundsByKey.get(key);
    if (knownRefund) return reply.code(202).send({ refundId: knownRefund });

    const payment = ledger.paymentsById.get(request.body.paymentId);
    if (!payment || payment.status !== 'succeeded') return problem(reply, 409, 'not_refundable');

    const refundId = `ref-${randomUUID()}`;
    ledger.refundsByKey.set(key, refundId);
    const world = ledger.generation;
    setTimeout(() => {
      if (world !== ledger.generation) return;
      payment.status = 'refunded';
      void deliver('/webhooks/psp', {
        type: 'refund.succeeded',
        paymentId: payment.paymentId,
        refundId,
        orderId: payment.orderId,
        amountCents: payment.amountCents,
      });
    }, scaled(between(100, 500)));

    return reply.code(202).send({ refundId });
  });

  // --- Restaurants ---

  app.post<{ Params: { restaurantId: string }; Body: { orderId: string } }>(
    '/restaurants/:restaurantId/orders',
    async (request, reply) => {
      const { restaurantId } = request.params;
      const { orderId } = request.body;
      const restaurant = ledger.restaurants.get(restaurantId);
      if (!restaurant) return problem(reply, 404, 'unknown_restaurant');

      if (restaurantId === knobs.slowRestaurantId) await sleep(between(3000, 8000));

      const already = ledger.kitchenAccepted.get(orderId);
      if (already) return reply.code(200).send({ orderId, estimatedReadyAt: already });

      if (restaurant.cooking.size >= restaurant.capacity) {
        recordViolation('kitchen_full', `${restaurantId} (capacité ${restaurant.capacity}) a reçu ${orderId}`);
        return problem(reply, 409, 'kitchen_full');
      }

      const prepMs = scaled(between(2000, 6000));
      const estimatedReadyAt = new Date(Date.now() + prepMs).toISOString();
      restaurant.cooking.add(orderId);
      ledger.kitchenAccepted.set(orderId, estimatedReadyAt);

      const world = ledger.generation;
      setTimeout(() => {
        if (world !== ledger.generation) return;
        restaurant.cooking.delete(orderId);
        if (Math.random() < knobs.readyAfterPickupRate) {
          // Le livreur part tout de suite ; le restaurant ne prévient le système que plus tard.
          markReady(orderId);
          setTimeout(
            () => void deliver('/webhooks/restaurants', { type: 'order.ready', restaurantId, orderId }),
            scaled(between(3000, 5000)),
          );
        } else {
          void deliver('/webhooks/restaurants', { type: 'order.ready', restaurantId, orderId }).then(() =>
            markReady(orderId),
          );
        }
      }, prepMs);

      return reply.code(200).send({ orderId, estimatedReadyAt });
    },
  );

  // --- Livreurs ---

  app.post<{
    Params: { courierId: string };
    Body: { orderId: string; restaurantId: string; deliveryLocation: Location };
  }>('/couriers/:courierId/assignments', async (request, reply) => {
    const { courierId } = request.params;
    const { orderId, restaurantId, deliveryLocation } = request.body;
    const courier = ledger.couriers.get(courierId);
    const restaurant = ledger.restaurants.get(restaurantId);
    if (!courier || !restaurant) return problem(reply, 404, 'unknown_courier_or_restaurant');

    if (courier.busyWith === orderId) return reply.code(201).send();
    if (courier.busyWith) {
      recordViolation('courier_busy', `${courierId} déjà sur ${courier.busyWith}, a reçu ${orderId}`);
      return problem(reply, 409, 'courier_busy');
    }
    courier.busyWith = orderId;
    runDelivery(courierId, orderId, restaurant.location, deliveryLocation).catch((err) =>
      log(`course ${orderId} interrompue`, err),
    );
    return reply.code(201).send();
  });

  // --- Diagnostics ---

  app.post<{ Body: { restaurantId: string; traceId?: string } }>(
    '/diagnostics/slow-restaurant',
    async (request, reply) => {
      ledger.diagnosis = { restaurantId: request.body.restaurantId, traceId: request.body.traceId };
      log(`restaurant lent désigné : ${request.body.restaurantId} (trace ${request.body.traceId ?? '—'})`);
      return reply.code(204).send();
    },
  );

  // Positions : un lot par seconde, sans nouvelle tentative.
  setInterval(() => {
    if (ledger.couriers.size === 0) return;
    const at = new Date().toISOString();
    const positions = [...ledger.couriers].map(([courierId, c]) => ({ courierId, location: c.location, at }));
    fetch(config.systemUrl + '/webhooks/couriers/positions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positions }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  }, 1000);
}
