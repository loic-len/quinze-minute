export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://quinze:quinze@localhost:5432/quinze',
  amqpUrl: process.env.AMQP_URL ?? 'amqp://quinze:quinze@localhost:5672',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  partnersUrl: process.env.PARTNERS_URL ?? 'http://localhost:9000',
};
