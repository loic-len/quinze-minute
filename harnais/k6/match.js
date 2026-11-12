// Clients simulés d'un match : arrivées au rythme de la courbe (modèle ouvert), une commande par client.
// Lancé par l'orchestrateur ; chaque client déclare son résultat à l'orchestrateur pour la corrélation.
import http from 'k6/http';
import { sleep } from 'k6';

const config = JSON.parse(open(__ENV.CONFIG_FILE));
const world = JSON.parse(open(__ENV.WORLD_FILE));
const SYSTEM_URL = __ENV.SYSTEM_URL;
const HARNESS_URL = __ENV.HARNESS_URL;
const MAX_RETRIES = 3;

export const options = {
  scenarios: {
    match: {
      executor: 'ramping-arrival-rate',
      startRate: config.startRate,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 3000,
      stages: config.stages,
    },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  noConnectionReuse: false,
};

const json = { 'content-type': 'application/json' };

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function retryDelaySeconds(response, attempt) {
  const retryAfter = Number(response.headers['Retry-After']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, 10);
  return 0.2 * 2 ** attempt * (0.5 + Math.random());
}

export default function () {
  const restaurant = world.restaurants[Math.floor(Math.random() * world.restaurants.length)];
  const dish = restaurant.menu[Math.floor(Math.random() * restaurant.menu.length)];
  const body = JSON.stringify({
    customerId: `client-${__VU}-${__ITER}`,
    restaurantId: restaurant.restaurantId,
    items: [{ menuItemId: dish.menuItemId, quantity: 1 + Math.floor(Math.random() * 3) }],
    deliveryLocation: {
      lat: restaurant.location.lat + (Math.random() - 0.5) * 0.02,
      lng: restaurant.location.lng + (Math.random() - 0.5) * 0.02,
    },
  });
  const key = uuid();
  const attempts = [];
  let orderId = null;
  let outcome = 'failed';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const cut = Math.random() < config.clientCutRate;
    const at = Date.now();
    const response = http.post(`${SYSTEM_URL}/orders`, body, {
      headers: { ...json, 'Idempotency-Key': key },
      timeout: cut ? '30ms' : '5s',
      tags: { name: 'POST /orders' },
    });
    attempts.push({ status: response.status, ms: Math.round(response.timings.duration), at, cut });

    if (response.status === 201) {
      orderId = response.json('orderId');
      outcome = 'accepted';
      break;
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      outcome = 'rejected';
      break;
    }
    if (attempt === MAX_RETRIES) {
      outcome = response.status === 503 || response.status === 429 ? 'shed' : 'failed';
      break;
    }
    sleep(retryDelaySeconds(response, attempt));
  }

  http.post(
    `${HARNESS_URL}/_harness/orders`,
    JSON.stringify({ key, orderId, outcome, attempts, restaurantId: restaurant.restaurantId }),
    { headers: json, timeout: '10s', tags: { name: 'harnais' } },
  );

  if (orderId) {
    sleep(1 + Math.random() * 2);
    http.get(`${SYSTEM_URL}/orders/${orderId}`, { timeout: '5s', tags: { name: 'GET /orders/{id}' } });
  }
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_FILE]: JSON.stringify(data) };
}
