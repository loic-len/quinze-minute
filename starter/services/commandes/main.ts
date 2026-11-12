// Service « commandes » : API publique, cycle de vie des commandes, chargement du monde, audit.
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from '../../lib/config.ts';
import { pool } from '../../lib/db.ts';
import { redis } from '../../lib/redis.ts';
import { connectBus, publish, subscribe } from '../../lib/bus.ts';
import { problem } from '../../lib/http.ts';
import type {
  CancellationReason,
  Location,
  OrderItem,
  OrderSnapshot,
  OrderStatus,
} from '../../lib/types.ts';

interface OrderRow {
  id: string;
  idempotency_key: string;
  customer_id: string;
  restaurant_id: string;
  items: OrderItem[];
  delivery_lat: number;
  delivery_lng: number;
  amount_cents: number;
  status: OrderStatus;
  cancellation_reason: CancellationReason | null;
  courier_id: string | null;
  eta_seconds: number | null;
  created_at: Date;
}

function toOrder(row: OrderRow) {
  return {
    orderId: row.id,
    customerId: row.customer_id,
    restaurantId: row.restaurant_id,
    status: row.status,
    ...(row.cancellation_reason && { cancellationReason: row.cancellation_reason }),
    amountCents: row.amount_cents,
    ...(row.courier_id && { courierId: row.courier_id }),
    ...(row.eta_seconds !== null && { etaSeconds: row.eta_seconds }),
    createdAt: row.created_at.toISOString(),
  };
}

function toSnapshot(row: OrderRow): OrderSnapshot {
  return {
    orderId: row.id,
    customerId: row.customer_id,
    restaurantId: row.restaurant_id,
    items: row.items,
    deliveryLocation: { lat: row.delivery_lat, lng: row.delivery_lng },
    amountCents: row.amount_cents,
    status: row.status,
    ...(row.cancellation_reason && { cancellationReason: row.cancellation_reason }),
    ...(row.courier_id && { courierId: row.courier_id }),
    at: new Date().toISOString(),
  };
}

async function setStatus(orderId: string, status: OrderStatus, reason?: CancellationReason) {
  const { rows } = await pool.query<OrderRow>(
    `UPDATE orders SET status = $2, cancellation_reason = COALESCE($3, cancellation_reason)
     WHERE id = $1 RETURNING *`,
    [orderId, status, reason ?? null],
  );
  const order = rows[0];
  if (!order) {
    console.log(`commande inconnue : ${orderId}`);
    return;
  }
  await pool.query('INSERT INTO order_status_history (order_id, status) VALUES ($1, $2)', [orderId, status]);
  publish('order.status_changed', toSnapshot(order));
  console.log(`commande ${orderId} : ${status}`);
}

// ---------------------------------------------------------------------------
// Événements du bus
// ---------------------------------------------------------------------------

async function onEvent(routingKey: string, payload: any) {
  switch (routingKey) {
    case 'payment.succeeded':
      return setStatus(payload.orderId, 'paid');
    case 'payment.failed':
      return setStatus(payload.orderId, 'cancelled', 'payment_failed');
    case 'kitchen.accepted':
      return setStatus(payload.orderId, 'in_kitchen');
    case 'kitchen.refused':
      await setStatus(payload.orderId, 'cancelled', 'restaurant_refused');
      publish('refund.requested', { orderId: payload.orderId });
      return;
    case 'kitchen.ready':
      return setStatus(payload.orderId, 'ready');
    case 'courier.assigned':
      await pool.query('UPDATE orders SET courier_id = $2, eta_seconds = $3 WHERE id = $1', [
        payload.orderId,
        payload.courierId,
        payload.etaSeconds,
      ]);
      return;
    case 'order.eta':
      await pool.query('UPDATE orders SET eta_seconds = $2 WHERE id = $1', [payload.orderId, payload.etaSeconds]);
      return;
    case 'courier.picked_up':
      return setStatus(payload.orderId, 'picked_up');
    case 'courier.delivered':
      return setStatus(payload.orderId, 'delivered');
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = Fastify();

interface CreateOrderBody {
  customerId: string;
  restaurantId: string;
  items: OrderItem[];
  deliveryLocation: Location;
}

const createOrderSchema = {
  body: {
    type: 'object',
    required: ['customerId', 'restaurantId', 'items', 'deliveryLocation'],
    properties: {
      customerId: { type: 'string', minLength: 1 },
      restaurantId: { type: 'string', minLength: 1 },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          type: 'object',
          required: ['menuItemId', 'quantity'],
          properties: {
            menuItemId: { type: 'string', minLength: 1 },
            quantity: { type: 'integer', minimum: 1, maximum: 10 },
          },
        },
      },
      deliveryLocation: {
        type: 'object',
        required: ['lat', 'lng'],
        properties: { lat: { type: 'number' }, lng: { type: 'number' } },
      },
    },
  },
};

app.post<{ Body: CreateOrderBody }>('/orders', { schema: createOrderSchema }, async (request, reply) => {
  const idempotencyKey = request.headers['idempotency-key'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) {
    return problem(reply, 400, 'Idempotency-Key manquante');
  }
  const { customerId, restaurantId, items, deliveryLocation } = request.body;

  const menu = await pool.query<{ id: string; price_cents: number }>(
    'SELECT id, price_cents FROM menu_items WHERE restaurant_id = $1',
    [restaurantId],
  );
  if (menu.rowCount === 0) return problem(reply, 404, 'restaurant inconnu');
  const prices = new Map(menu.rows.map((m) => [m.id, m.price_cents]));

  let amountCents = 0;
  for (const item of items) {
    const price = prices.get(item.menuItemId);
    if (price === undefined) return problem(reply, 422, 'article inconnu', item.menuItemId);
    amountCents += price * item.quantity;
  }

  const { rows } = await pool.query<OrderRow>(
    `INSERT INTO orders (id, idempotency_key, customer_id, restaurant_id, items, delivery_lat, delivery_lng, amount_cents, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'payment_pending') RETURNING *`,
    [
      randomUUID(),
      idempotencyKey,
      customerId,
      restaurantId,
      JSON.stringify(items),
      deliveryLocation.lat,
      deliveryLocation.lng,
      amountCents,
    ],
  );
  const order = rows[0]!;
  await pool.query('INSERT INTO order_status_history (order_id, status) VALUES ($1, $2)', [
    order.id,
    'payment_pending',
  ]);

  publish('order.created', toSnapshot(order));
  console.log(`commande ${order.id} créée (${amountCents} centimes)`);
  return reply.code(201).send(toOrder(order));
});

app.get<{ Params: { orderId: string } }>('/orders/:orderId', async (request, reply) => {
  const { rows } = await pool.query<OrderRow>('SELECT * FROM orders WHERE id::text = $1', [
    request.params.orderId,
  ]);
  if (!rows[0]) return problem(reply, 404, 'commande inconnue');
  return toOrder(rows[0]);
});

// --- Pilotage par le harnais ---

interface World {
  restaurants: {
    restaurantId: string;
    name: string;
    location: Location;
    kitchenCapacity: number;
    menu: { menuItemId: string; name: string; priceCents: number }[];
  }[];
  couriers: { courierId: string; location: Location }[];
}

app.post<{ Body: World }>('/admin/world', async (request, reply) => {
  const world = request.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'TRUNCATE orders, order_status_history, payments, kitchen_orders, couriers, menu_items, restaurants CASCADE',
    );
    for (const r of world.restaurants) {
      await client.query(
        'INSERT INTO restaurants (id, name, lat, lng, kitchen_capacity) VALUES ($1, $2, $3, $4, $5)',
        [r.restaurantId, r.name, r.location.lat, r.location.lng, r.kitchenCapacity],
      );
      for (const m of r.menu) {
        await client.query(
          'INSERT INTO menu_items (restaurant_id, id, name, price_cents) VALUES ($1, $2, $3, $4)',
          [r.restaurantId, m.menuItemId, m.name, m.priceCents],
        );
      }
    }
    for (const c of world.couriers) {
      await client.query('INSERT INTO couriers (id, lat, lng) VALUES ($1, $2, $3)', [
        c.courierId,
        c.location.lat,
        c.location.lng,
      ]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await redis.flushdb();
  publish('world.reset', {});
  console.log(
    `monde chargé : ${world.restaurants.length} restaurants, ${world.couriers.length} livreurs`,
  );
  return reply.code(204).send();
});

app.get<{ Querystring: { cursor?: string; limit?: string } }>('/audit', async (request) => {
  const limit = Math.min(Math.max(Number(request.query.limit ?? 500), 1), 1000);
  const cursor = request.query.cursor ?? '00000000-0000-0000-0000-000000000000';

  const { rows: orders } = await pool.query<OrderRow>(
    'SELECT * FROM orders WHERE id > $1 ORDER BY id LIMIT $2',
    [cursor, limit],
  );
  const ids = orders.map((o) => o.id);
  const { rows: payments } = await pool.query<{ id: string; order_id: string; status: string }>(
    'SELECT id, order_id, status FROM payments WHERE order_id = ANY($1)',
    [ids],
  );
  const { rows: history } = await pool.query<{ order_id: string; status: OrderStatus; at: Date }>(
    'SELECT order_id, status, at FROM order_status_history WHERE order_id = ANY($1) ORDER BY id',
    [ids],
  );

  return {
    orders: orders.map((o) => ({
      orderId: o.id,
      idempotencyKey: o.idempotency_key,
      status: o.status,
      ...(o.cancellation_reason && { cancellationReason: o.cancellation_reason }),
      amountCents: o.amount_cents,
      restaurantId: o.restaurant_id,
      ...(o.courier_id && { courierId: o.courier_id }),
      payments: payments
        .filter((p) => p.order_id === o.id)
        .map((p) => ({ paymentId: p.id, status: p.status })),
      statusHistory: history
        .filter((h) => h.order_id === o.id)
        .map((h) => ({ status: h.status, at: h.at.toISOString() })),
    })),
    ...(orders.length === limit && { nextCursor: orders[orders.length - 1]!.id }),
  };
});

app.get('/health/live', async () => ({ status: 'ok' }));
app.get('/health/ready', async () => ({ status: 'ok' }));

// ---------------------------------------------------------------------------

await connectBus();
await subscribe(
  'commandes',
  ['payment.*', 'kitchen.*', 'courier.*', 'order.eta'],
  onEvent,
);
await app.listen({ host: '0.0.0.0', port: config.port });
console.log(`commandes écoute sur ${config.port}`);
