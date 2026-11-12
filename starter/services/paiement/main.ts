// Service « paiement » : débit et remboursement via le PSP, réception de ses webhooks.
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from '../../lib/config.ts';
import { pool } from '../../lib/db.ts';
import { connectBus, publish, subscribe } from '../../lib/bus.ts';
import { callPartner } from '../../lib/http.ts';
import type { OrderSnapshot } from '../../lib/types.ts';

const MAX_ATTEMPTS = 5;

async function charge(order: OrderSnapshot) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await callPartner<{ paymentId: string }>(
        '/psp/payments',
        { orderId: order.orderId, customerId: order.customerId, amountCents: order.amountCents },
        { 'idempotency-key': randomUUID() },
      );
      if (response.status === 202) {
        await pool.query(
          `INSERT INTO payments (id, order_id, status) VALUES ($1, $2, 'pending') ON CONFLICT (id) DO NOTHING`,
          [response.body.paymentId, order.orderId],
        );
        console.log(`paiement ${response.body.paymentId} demandé pour ${order.orderId}`);
        return;
      }
      console.log(`PSP : réponse ${response.status} pour ${order.orderId} (tentative ${attempt})`);
    } catch (err) {
      console.log(`PSP injoignable pour ${order.orderId} (tentative ${attempt})`, err);
    }
  }
  console.log(`paiement abandonné pour ${order.orderId}`);
}

async function refund(orderId: string) {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM payments WHERE order_id = $1 AND status = 'succeeded' LIMIT 1`,
    [orderId],
  );
  const payment = rows[0];
  if (!payment) {
    console.log(`rien à rembourser pour ${orderId}`);
    return;
  }
  const response = await callPartner(
    '/psp/refunds',
    { paymentId: payment.id },
    { 'idempotency-key': randomUUID() },
  );
  console.log(`remboursement de ${payment.id} demandé : ${response.status}`);
}

async function onEvent(routingKey: string, payload: any) {
  switch (routingKey) {
    case 'order.created':
      return charge(payload as OrderSnapshot);
    case 'refund.requested':
      return refund(payload.orderId);
  }
}

// ---------------------------------------------------------------------------

const app = Fastify();

interface PspEvent {
  eventId: string;
  type: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded';
  paymentId: string;
  orderId: string;
  amountCents: number;
}

app.post<{ Body: PspEvent }>('/webhooks/psp', async (request, reply) => {
  const event = request.body;
  switch (event.type) {
    case 'payment.succeeded':
      await pool.query(`UPDATE payments SET status = 'succeeded' WHERE id = $1`, [event.paymentId]);
      publish('payment.succeeded', { orderId: event.orderId, paymentId: event.paymentId });
      break;
    case 'payment.failed':
      await pool.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [event.paymentId]);
      publish('payment.failed', { orderId: event.orderId, paymentId: event.paymentId });
      break;
    case 'refund.succeeded':
      await pool.query(`UPDATE payments SET status = 'refunded' WHERE id = $1`, [event.paymentId]);
      publish('payment.refunded', { orderId: event.orderId, paymentId: event.paymentId });
      break;
  }
  console.log(`webhook PSP ${event.type} pour ${event.orderId}`);
  return reply.code(204).send();
});

// ---------------------------------------------------------------------------

await connectBus();
await subscribe('paiement', ['order.created', 'refund.requested'], onEvent);
await app.listen({ host: '0.0.0.0', port: config.port });
console.log(`paiement écoute sur ${config.port}`);
