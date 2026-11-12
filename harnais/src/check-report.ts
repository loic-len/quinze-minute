// Outil enseignant : vérifie la signature d'un ou plusieurs rapports et affiche un classement.
//   node src/check-report.ts rapports/*.json
import { readFile } from 'node:fs/promises';
import { checkSignature } from './report.ts';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log('usage : node src/check-report.ts <rapport.json>...');
  process.exit(2);
}

const rows: { file: string; palier: string; ok: boolean; passed: boolean; score: number; p99: string }[] = [];
for (const file of files) {
  const report = JSON.parse(await readFile(file, 'utf8'));
  rows.push({
    file,
    palier: report.palier,
    ok: checkSignature(report),
    passed: report.passed,
    score: report.score,
    p99: String(report.metrics?.postOrdersMs?.peak?.p99 ?? '—'),
  });
}

rows.sort((a, b) => Number(b.ok && b.passed) - Number(a.ok && a.passed) || b.score - a.score);
for (const r of rows) {
  console.log(
    `${r.ok ? 'signé  ' : 'FALSIFIÉ'}  ${r.palier.padEnd(9)}  ${r.passed ? 'franchi' : 'raté   '}  score ${String(r.score).padStart(6)}  p99 ${r.p99.padStart(6)} ms  ${r.file}`,
  );
}
