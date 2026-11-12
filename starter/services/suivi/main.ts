// Service « suivi » : flux SSE par commande (statut, position du livreur, ETA).
import Fastify from 'fastify';
import type { ServerResponse } from 'node:http';
import { config } from '../../lib/config.ts';
import { pool } from '../../lib/db.ts';
import { COURIER_POSITIONS_KEY, redis } from '../../lib/redis.ts';
import { connectBus, subscribe } from '../../lib/bus.ts';
import { problem } from '../../lib/http.ts';
import type { Location, OrderSnapshot, OrderStatus } from '../../lib/types.ts';

const TERMINAL: OrderStatus[] = ['delivered', 'cancelled'];

/** Flux SSE ouverts, par commande. */
const streams = new Map<string, Set<ServerResponse>>();
/** Commande en cours de chaque livreur. */
const orderOfCourier = new Map<string, string>();

function send(orderId: string, event: string, data: unknown) {
  for (const stream of streams.get(orderId) ?? []) {
    stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function closeStreams(orderId: string) {
  for (const stream of streams.get(orderId) ?? []) stream.end();
  streams.delete(orderId);
}

// ---------------------------------------------------------------------------
// Événements du bus
// ---------------------------------------------------------------------------

async function onEvent(routingKey: string, payload: any) {
  switch (routingKey) {
    case 'order.status_changed': {
      const order = payload as OrderSnapshot;
      send(order.orderId, 'status', {
        orderId: order.orderId,
        status: order.status,
        ...(order.cancellationReason && { cancellationReason: order.cancellationReason }),
        at: order.at,
      });
      if (TERMINAL.includes(order.status)) {
        closeStreams(order.orderId);
        if (order.courierId) orderOfCourier.delete(order.courierId);
      }
      return;
    }
    case 'courier.assigned':
      orderOfCourier.set(payload.courierId, payload.orderId);
      send(payload.orderId, 'eta', {
        orderId: payload.orderId,
        etaSeconds: payload.etaSeconds,
        at: new Date().toISOString(),
      });
      return;
    case 'order.eta':
      send(payload.orderId, 'eta', {
        orderId: payload.orderId,
        etaSeconds: payload.etaSeconds,
        at: new Date().toISOString(),
      });
      return;
    case 'world.reset':
      for (const orderId of [...streams.keys()]) closeStreams(orderId);
      orderOfCourier.clear();
      return;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = Fastify();

app.get<{ Params: { orderId: string } }>('/orders/:orderId/events', async (request, reply) => {
  const { orderId } = request.params;
  const { rows } = await pool.query<{ status: OrderStatus; cancellation_reason: string | null }>(
    'SELECT status, cancellation_reason FROM orders WHERE id::text = $1',
    [orderId],
  );
  const order = rows[0];
  if (!order) return problem(reply, 404, 'commande inconnue');

  reply.hijack();
  const stream = reply.raw;
  stream.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  stream.write(
    `event: status\ndata: ${JSON.stringify({
      orderId,
      status: order.status,
      ...(order.cancellation_reason && { cancellationReason: order.cancellation_reason }),
      at: new Date().toISOString(),
    })}\n\n`,
  );
  if (TERMINAL.includes(order.status)) {
    stream.end();
    return;
  }

  const set = streams.get(orderId) ?? new Set<ServerResponse>();
  streams.set(orderId, set);
  set.add(stream);
  stream.on('close', () => set.delete(stream));
});

interface PositionBatch {
  positions: { courierId: string; location: Location; at: string }[];
}

app.post<{ Body: PositionBatch }>('/webhooks/couriers/positions', async (request, reply) => {
  for (const { courierId, location, at } of request.body.positions) {
    await redis.hset(COURIER_POSITIONS_KEY, courierId, JSON.stringify({ ...location, at }));
    const orderId = orderOfCourier.get(courierId);
    if (orderId) send(orderId, 'courier_position', { orderId, courierId, location, at });
  }
  return reply.code(204).send();
});

// ---------------------------------------------------------------------------

await connectBus();
await subscribe('suivi', ['order.status_changed', 'courier.assigned', 'order.eta', 'world.reset'], onEvent);
await app.listen({ host: '0.0.0.0', port: config.port });
console.log(`suivi écoute sur ${config.port}`);
