// Service « dispatch » : envoi en cuisine, assignation des livreurs, estimation des délais.
import Fastify from 'fastify';
import { config } from '../../lib/config.ts';
import { pool } from '../../lib/db.ts';
import { COURIER_POSITIONS_KEY, redis } from '../../lib/redis.ts';
import { connectBus, publish, subscribe } from '../../lib/bus.ts';
import { callPartner } from '../../lib/http.ts';
import type { Location, OrderSnapshot } from '../../lib/types.ts';
import { travelSeconds, travelSecondsVia } from './eta.ts';

const RETRY_EVERY_MS = 1000;
const ETA_REFRESH_EVERY_MS = 5000;

/** Commandes en attente d'une place en cuisine ou d'un livreur, réessayées périodiquement. */
const waiting: { step: 'kitchen' | 'courier'; order: OrderSnapshot }[] = [];

/** Courses en cours, pour rafraîchir l'ETA. */
const activeDeliveries = new Map<
  string,
  { courierId: string; restaurant: Location; delivery: Location; pickedUp: boolean }
>();

async function restaurantOf(restaurantId: string) {
  const { rows } = await pool.query<{ lat: number; lng: number; kitchen_capacity: number }>(
    'SELECT lat, lng, kitchen_capacity FROM restaurants WHERE id = $1',
    [restaurantId],
  );
  return rows[0];
}

async function courierPosition(courier: { id: string; lat: number; lng: number }): Promise<Location> {
  const known = await redis.hget(COURIER_POSITIONS_KEY, courier.id);
  if (known) {
    const { lat, lng } = JSON.parse(known);
    return { lat, lng };
  }
  return { lat: courier.lat, lng: courier.lng };
}

// ---------------------------------------------------------------------------
// Cuisine
// ---------------------------------------------------------------------------

async function sendToKitchen(order: OrderSnapshot) {
  const restaurant = await restaurantOf(order.restaurantId);
  if (!restaurant) return;

  const { rows } = await pool.query<{ cooking: number }>(
    `SELECT count(*)::int AS cooking FROM kitchen_orders WHERE restaurant_id = $1 AND state = 'cooking'`,
    [order.restaurantId],
  );
  if (rows[0]!.cooking >= restaurant.kitchen_capacity) {
    waiting.push({ step: 'kitchen', order });
    return;
  }

  const response = await callPartner(`/restaurants/${order.restaurantId}/orders`, {
    orderId: order.orderId,
    items: order.items,
  });
  if (response.status === 200) {
    await pool.query(
      `INSERT INTO kitchen_orders (order_id, restaurant_id, state) VALUES ($1, $2, 'cooking')
       ON CONFLICT (order_id) DO NOTHING`,
      [order.orderId, order.restaurantId],
    );
    publish('kitchen.accepted', { orderId: order.orderId });
    console.log(`commande ${order.orderId} acceptée en cuisine`);
  } else if (response.status === 422) {
    publish('kitchen.refused', { orderId: order.orderId });
    console.log(`commande ${order.orderId} refusée par le restaurant`);
  } else {
    console.log(`restaurant ${order.restaurantId} : réponse ${response.status}, on réessaiera`);
    waiting.push({ step: 'kitchen', order });
  }
}

// ---------------------------------------------------------------------------
// Livreurs
// ---------------------------------------------------------------------------

async function assignCourier(order: OrderSnapshot) {
  const { rows: couriers } = await pool.query<{ id: string; lat: number; lng: number }>(
    'SELECT id, lat, lng FROM couriers WHERE available',
  );
  if (couriers.length === 0) {
    waiting.push({ step: 'courier', order });
    return;
  }
  const restaurant = await restaurantOf(order.restaurantId);
  if (!restaurant) return;
  const restaurantLocation = { lat: restaurant.lat, lng: restaurant.lng };

  const positions = await Promise.all(couriers.map((c) => courierPosition(c)));

  // Le livreur qui livrera le plus tôt : rejoindre le restaurant puis le client.
  let best: { courierId: string; etaSeconds: number } | undefined;
  couriers.forEach((courier, i) => {
    const etaSeconds = travelSecondsVia(positions[i]!, restaurantLocation, order.deliveryLocation);
    if (!best || etaSeconds < best.etaSeconds) best = { courierId: courier.id, etaSeconds };
  });
  const chosen = best!;

  await pool.query('UPDATE couriers SET available = false WHERE id = $1', [chosen.courierId]);
  const response = await callPartner(`/couriers/${chosen.courierId}/assignments`, {
    orderId: order.orderId,
    restaurantId: order.restaurantId,
    deliveryLocation: order.deliveryLocation,
  });
  if (response.status !== 201) {
    console.log(`livreur ${chosen.courierId} : réponse ${response.status}, on réessaiera`);
    // 409 : le livreur est déjà en course, son webhook « livrée » le rendra disponible.
    if (response.status !== 409) {
      await pool.query('UPDATE couriers SET available = true WHERE id = $1', [chosen.courierId]);
    }
    waiting.push({ step: 'courier', order });
    return;
  }

  activeDeliveries.set(order.orderId, {
    courierId: chosen.courierId,
    restaurant: restaurantLocation,
    delivery: order.deliveryLocation,
    pickedUp: false,
  });
  publish('courier.assigned', { orderId: order.orderId, ...chosen });
  console.log(`commande ${order.orderId} : livreur ${chosen.courierId}, ETA ${chosen.etaSeconds} s`);
}

async function refreshEtas() {
  for (const [orderId, delivery] of activeDeliveries) {
    const known = await redis.hget(COURIER_POSITIONS_KEY, delivery.courierId);
    if (!known) continue;
    const { lat, lng } = JSON.parse(known);
    const etaSeconds = delivery.pickedUp
      ? travelSeconds({ lat, lng }, delivery.delivery)
      : travelSecondsVia({ lat, lng }, delivery.restaurant, delivery.delivery);
    publish('order.eta', { orderId, etaSeconds });
  }
}

let retrying = false;
/** Incrémenté à chaque nouveau monde : le travail en cours de l'ancien monde est abandonné. */
let worldGeneration = 0;

/** Réessaie la file d'attente, une commande après l'autre. */
async function retryWaiting() {
  if (retrying) return;
  retrying = true;
  const generation = worldGeneration;
  try {
    for (const task of waiting.splice(0)) {
      if (generation !== worldGeneration) break;
      try {
        await (task.step === 'kitchen' ? sendToKitchen(task.order) : assignCourier(task.order));
      } catch (err) {
        console.log(`erreur en réessayant ${task.order.orderId}`, err);
      }
    }
  } finally {
    retrying = false;
  }
}

// ---------------------------------------------------------------------------
// Événements du bus
// ---------------------------------------------------------------------------

async function onEvent(routingKey: string, payload: any) {
  if (routingKey === 'world.reset') {
    worldGeneration++;
    waiting.length = 0;
    activeDeliveries.clear();
    return;
  }
  const order = payload as OrderSnapshot;
  if (order.status === 'paid') return sendToKitchen(order);
  if (order.status === 'in_kitchen') return assignCourier(order);
}

// ---------------------------------------------------------------------------
// Webhooks des partenaires
// ---------------------------------------------------------------------------

const app = Fastify();

interface PartnerEvent {
  eventId: string;
  type: string;
  orderId: string;
  restaurantId?: string;
  courierId?: string;
}

app.post<{ Body: PartnerEvent }>('/webhooks/restaurants', async (request, reply) => {
  const event = request.body;
  if (event.type === 'order.ready') {
    await pool.query(`UPDATE kitchen_orders SET state = 'ready' WHERE order_id = $1`, [event.orderId]);
    publish('kitchen.ready', { orderId: event.orderId });
    console.log(`commande ${event.orderId} prête`);
  }
  return reply.code(204).send();
});

app.post<{ Body: PartnerEvent }>('/webhooks/couriers', async (request, reply) => {
  const event = request.body;
  if (event.type === 'order.picked_up') {
    const delivery = activeDeliveries.get(event.orderId);
    if (delivery) delivery.pickedUp = true;
    publish('courier.picked_up', { orderId: event.orderId, courierId: event.courierId });
  } else if (event.type === 'order.delivered') {
    await pool.query('UPDATE couriers SET available = true WHERE id = $1', [event.courierId]);
    activeDeliveries.delete(event.orderId);
    publish('courier.delivered', { orderId: event.orderId, courierId: event.courierId });
  }
  console.log(`livreur ${event.courierId} : ${event.type} pour ${event.orderId}`);
  return reply.code(204).send();
});

// ---------------------------------------------------------------------------

await connectBus();
await subscribe('dispatch', ['order.status_changed', 'world.reset'], onEvent);
setInterval(() => void retryWaiting(), RETRY_EVERY_MS);
setInterval(() => {
  refreshEtas().catch((err) => console.log('erreur en rafraîchissant les ETA', err));
}, ETA_REFRESH_EVERY_MS);
await app.listen({ host: '0.0.0.0', port: config.port });
console.log(`dispatch écoute sur ${config.port}`);
