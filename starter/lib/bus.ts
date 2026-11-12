import amqp from 'amqplib';
import type { Channel } from 'amqplib';
import { config } from './config.ts';

const EXCHANGE = 'quinze';

let channel: Channel | undefined;

export async function connectBus(): Promise<void> {
  const connection = await amqp.connect(config.amqpUrl);
  channel = await connection.createChannel();
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
}

export function publish(routingKey: string, payload: unknown): void {
  if (!channel) throw new Error('bus non connecté');
  channel.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), {
    contentType: 'application/json',
  });
}

export type Handler = (routingKey: string, payload: any) => Promise<void>;

/** Abonne une file durable aux clés de routage données (motifs topic acceptés : `payment.*`). */
export async function subscribe(queue: string, routingKeys: string[], handler: Handler): Promise<void> {
  if (!channel) throw new Error('bus non connecté');
  await channel.assertQueue(queue, { durable: true });
  for (const key of routingKeys) {
    await channel.bindQueue(queue, EXCHANGE, key);
  }
  await channel.consume(
    queue,
    async (message) => {
      if (!message) return;
      const payload = JSON.parse(message.content.toString());
      try {
        await handler(message.fields.routingKey, payload);
      } catch (err) {
        console.log(`erreur en traitant ${message.fields.routingKey}`, err);
      }
    },
    { noAck: true },
  );
}
