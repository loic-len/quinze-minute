// Outil enseignant : enchaîne un palier à plusieurs débits de pointe et résume les résultats.
//   docker compose exec harness node src/calibrate.ts palier-1 8 12 16 20
// Chaque passage dure ≈ 6 min. Les rapports complets sont dans /reports.
import { config } from './config.ts';
import { scenarios } from './scenarios.ts';

const [name, ...rates] = process.argv.slice(2);
if (!name || !scenarios[name] || rates.length === 0) {
  console.log('usage : node src/calibrate.ts <palier> <débit de pointe>...');
  process.exit(2);
}

const base = config.selfUrl;
const rows: string[] = [];

for (const rate of rates.map(Number)) {
  const started = await fetch(`${base}/_harness/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario: name, peakRate: rate }),
  });
  if (started.status !== 202) {
    console.log(`${rate}/s : impossible de lancer (${(await started.json()).error})`);
    continue;
  }
  console.log(`${new Date().toISOString().slice(11, 19)}  ${name} au pic de ${rate} commandes/s…`);

  let s: any;
  do {
    await new Promise((r) => setTimeout(r, 5000));
    s = await (await fetch(`${base}/_harness/runs/current`)).json();
  } while (!['done', 'error'].includes(s.status));

  if (s.status === 'error') {
    rows.push(`${String(rate).padStart(5)}  erreur : ${s.error}`);
    continue;
  }
  const r = s.report;
  const m = r.metrics;
  const completed = m.orders.delivered + m.orders.cancelled;
  const violations = r.invariants.map((i: any) => `${i.id}:${i.violations}`).join(' ');
  rows.push(
    `${String(rate).padStart(5)}  ${r.passed ? 'franchi' : 'raté   '}  p95 pic ${String(m.postOrdersMs.peak.p95 ?? '—').padStart(6)} ms  p99 ${String(m.postOrdersMs.peak.p99 ?? '—').padStart(6)} ms` +
      `  terminées ${String(Math.round((100 * completed) / Math.max(1, m.clients.accepted))).padStart(3)} %` +
      `  livrées ${String(m.orders.delivered).padStart(5)}  refus ${String(m.clients.shed).padStart(4)}  violations ${violations}`,
  );
  const hot = (r.cpu ?? []).filter((c: any) => c.maxOfLimit >= 0.9).map((c: any) => c.container);
  if (hot.length) rows[rows.length - 1] += `  saturés : ${hot.join(', ')}`;
  console.log(rows.at(-1));
}

console.log(`\nCalibrage de ${name}\n  pic  verdict`);
for (const row of rows) console.log(row);
