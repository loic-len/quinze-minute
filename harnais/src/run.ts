// Lance un palier depuis la ligne de commande et suit son déroulé :
//   docker compose exec harness node src/run.ts palier-1 [--peak 16]
import { config } from './config.ts';
import { scenarios } from './scenarios.ts';

const name = process.argv[2];
const peakIndex = process.argv.indexOf('--peak');
const peakRate = peakIndex > 0 ? Number(process.argv[peakIndex + 1]) : undefined;
if (!name || !scenarios[name]) {
  console.log(`usage : node src/run.ts <${Object.keys(scenarios).join('|')}> [--peak <commandes/s>]`);
  process.exit(2);
}

const base = config.selfUrl;
const started = await fetch(`${base}/_harness/runs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ scenario: name, peakRate }),
});
if (started.status !== 202) {
  console.log(`impossible de lancer ${name} : ${(await started.json()).error}`);
  process.exit(1);
}
console.log(`${scenarios[name]!.title} lancé — page live : http://localhost:${config.port}/\n`);

let lastLine = '';
let seenChaos = 0;
for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = await (await fetch(`${base}/_harness/runs/current`)).json();
  for (const c of s.chaosLog.slice(seenChaos)) console.log(`  ⚡ ${c.at} s : ${c.label}${c.error ? ` (non joué : ${c.error})` : ''}`);
  seenChaos = s.chaosLog.length;

  const line =
    `${String(s.elapsed).padStart(4)} / ${s.total} s  ${(s.phase ?? s.status).padEnd(20)}` +
    `  clients ${s.totals.clients}  acceptées ${s.totals.accepted}  livrées ${s.totals.delivered}` +
    `  p99(10 s) ${s.p99Last10s ?? '—'} ms  violations ${s.violations}`;
  if (line !== lastLine) console.log(line);
  lastLine = line;

  if (s.status === 'error') {
    console.log(`\nPassage interrompu : ${s.error}`);
    process.exit(1);
  }
  if (s.status === 'done') {
    const r = s.report;
    console.log(`\n${r.titre} — ${r.passed ? 'PALIER FRANCHI' : 'PALIER NON FRANCHI'} — score ${r.score}\n`);
    for (const c of r.criteria) console.log(`  ${c.ok ? 'ok' : 'KO'}  ${c.name} : ${c.value} (attendu ${c.threshold})`);
    console.log('');
    for (const i of r.invariants) {
      const mark = i.violations === 0 ? 'ok' : i.blocking ? 'KO' : '!!';
      const note = i.blocking ? '' : ' (non bloquant à ce palier)';
      console.log(`  ${mark}  ${i.id}. ${i.name}${i.violations ? ` : ${i.violations}` : ''}${note}`);
      for (const e of i.examples) console.log(`        ${e}`);
    }
    if (r.cpu?.length) {
      console.log('\n  CPU par conteneur (cœurs : moyenne / maximum / limite)');
      for (const c of r.cpu) {
        const limit = c.limitCores === undefined ? '—' : String(c.limitCores);
        const flag = c.maxOfLimit !== undefined && c.maxOfLimit >= 0.9 ? '  ← saturé' : '';
        console.log(`    ${c.container.padEnd(16)} ${String(c.meanCores).padStart(5)} / ${String(c.maxCores).padStart(5)} / ${limit.padStart(5)}${flag}`);
      }
    }
    for (const remark of r.remarques) console.log(`\n  remarque : ${remark}`);
    if (r.fichier) console.log(`\nRapport : ${r.fichier}`);
    process.exit(r.passed ? 0 : 1);
  }
}
