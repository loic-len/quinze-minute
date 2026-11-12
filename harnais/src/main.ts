// Harnais Quinze Minutes : partenaires simulés + orchestrateur des paliers + page live.
import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { config, VERSION } from './config.ts';
import { maybeObserve } from './observers.ts';
import { isRunning, startRun } from './orchestrator.ts';
import { doubleCharges, ledger, loadPartnersWorld, registerPartners } from './partners.ts';
import type { ClientRecord } from './run-state.ts';
import { run, snapshot } from './run-state.ts';
import { scenarios } from './scenarios.ts';
import { log } from './util.ts';
import type { World } from './world.ts';

const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

const app = Fastify({ bodyLimit: 20 * 1024 * 1024 });
registerPartners(app);

// --- Page live ---

app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(page));

app.get('/_harness/scenarios', async () =>
  Object.values(scenarios).map((s) => ({ name: s.name, title: s.title })),
);

app.get('/_harness/live', (request, reply) => {
  reply.hijack();
  const stream = reply.raw;
  stream.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const push = () => stream.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  push();
  const timer = setInterval(push, 1000);
  request.raw.on('close', () => clearInterval(timer));
});

// --- Passages ---

app.post<{ Body: { scenario: string; peakRate?: number } }>('/_harness/runs', async (request, reply) => {
  try {
    await startRun(request.body.scenario, request.body.peakRate);
    return reply.code(202).send(snapshot());
  } catch (err) {
    return reply.code(409).send({ error: (err as Error).message });
  }
});

app.get('/_harness/runs/current', async () => snapshot());

/** Déclarations des clients k6, une par client. */
app.post<{ Body: ClientRecord }>('/_harness/orders', async (request, reply) => {
  const record = request.body;
  run.records.push(record);
  if (record.outcome === 'accepted' && record.orderId) {
    run.acceptedIds.add(record.orderId);
    maybeObserve(record.orderId);
  }
  return reply.code(204).send();
});

// --- Pilotage manuel (test de fumée) ---

app.post<{ Body: World }>('/_harness/world', async (request, reply) => {
  if (isRunning()) return reply.code(409).send({ error: 'un passage est en cours' });
  loadPartnersWorld(request.body);
  log(`monde chargé : ${ledger.restaurants.size} restaurants, ${ledger.couriers.size} livreurs`);
  return reply.code(204).send();
});

app.get('/_harness/ledger', async () => ({
  violations: [
    ...ledger.violations,
    ...doubleCharges().map(([orderId, n]) => ({
      invariant: 'double_charge',
      detail: `${orderId} : ${n} paiements réussis non remboursés`,
      at: new Date().toISOString(),
    })),
  ],
  payments: [...ledger.paymentsById.values()],
}));

await app.listen({ host: '0.0.0.0', port: config.port });
log(`harnais ${VERSION} sur le port ${config.port}, système testé : ${config.systemUrl}`);
log(`page live : http://localhost:${config.port}/`);
