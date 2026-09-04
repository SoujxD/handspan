/**
 * Print the adaptation ledger.
 *
 *   npx tsx scripts/adaptation-report.ts
 *   npx tsx scripts/adaptation-report.ts --json
 */

import { PATHS, PROJECT_ROOT } from '../src/config.js';
import { computeAdaptation } from '../src/catalog/adaptation.js';

const report = computeAdaptation({
  projectRoot: PROJECT_ROOT,
  evidenceDir: PATHS.evidence,
  artifactsDir: PATHS.artifacts,
  product: 'cornerstone-meridian-core',
  tenantId: 'meridian-demo',
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const line = (n = 78): string => '─'.repeat(n);
const usd = (n: number): string => `$${n.toFixed(2)}`;

console.log(`\n  ADAPTATION LEDGER — what app number 2,001 costs`);
console.log(`  ${line()}`);
console.log(`  baseline: ${report.baseline}    generated: ${report.generatedAt.slice(0, 19)}Z\n`);

console.log(`  ${report.headline.replace(/(.{74}\S*)\s/g, '$1\n  ')}\n`);

console.log(`  DIFF ECONOMICS`);
console.log(`  ${line()}`);
console.log(`  ${'bucket'.padEnd(10)} ${'files'.padStart(5)} ${'lines'.padStart(7)}   what it means`);
for (const b of report.diff.buckets) {
  console.log(
    `  ${b.bucket.padEnd(10)} ${String(b.files).padStart(5)} ${String(b.lines).padStart(7)}   ${b.means}`,
  );
}

console.log(`\n  ONBOARDING ECONOMICS — one discovery run per capability`);
console.log(`  ${line()}`);
console.log(
  `  ${'capability'.padEnd(38)} ${'calls'.padStart(5)} ${'actions'.padStart(7)} ${'in'.padStart(9)} ${'cached'.padStart(8)} ${'cost'.padStart(7)}`,
);
for (const d of report.discovery.runs) {
  console.log(
    `  ${(d.capabilityId ?? d.runId + "  (no artifact - run did not finish)").slice(0, 38).padEnd(38)} ${String(d.modelCalls).padStart(5)} ` +
      `${String(d.actions).padStart(7)} ${d.inputTokens.toLocaleString().padStart(9)} ` +
      `${d.cachedTokens.toLocaleString().padStart(8)} ${usd(d.estimatedUsd).padStart(7)}`,
  );
}
console.log(
  `  ${'TOTAL'.padEnd(38)} ${String(report.discovery.totalModelCalls).padStart(5)} ` +
    `${''.padStart(7)} ${''.padStart(9)} ${''.padStart(8)} ${usd(report.discovery.totalEstimatedUsd).padStart(7)}`,
);
console.log(`\n  ${report.discovery.note.replace(/(.{74}\S*)\s/g, '$1\n  ')}`);

console.log(`\n  REPLAY ECONOMICS — the production path`);
console.log(`  ${line()}`);
console.log(`  runs                 ${report.replay.runs}`);
console.log(
  `  by result shape      ${Object.entries(report.replay.byStatus)
    .map(([k, v]) => `${k}=${v}`)
    .join('  ')}`,
);
console.log(`  mean duration        ${report.replay.meanDurationMs} ms`);
console.log(`  model calls          ${report.replay.totalLlmCalls}   <- asserted in code, not reported`);
console.log(`  cost per 1,000       $0.00 in tokens. Replay is a browser, not a model.`);

console.log(`\n  COVERAGE — MERIDIAN CORE's function surface`);
console.log(`  ${line()}`);
console.log(
  `  ${'capability'.padEnd(38)} ${'v'.padStart(2)} ${'steps'.padStart(5)} ${'out'.padStart(4)} ${'risk'.padEnd(12)} outcomes`,
);
for (const c of report.coverage) {
  const classes = Object.entries(c.byClass)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  console.log(
    `  ${c.capabilityId.slice(0, 38).padEnd(38)} ${String(c.version).padStart(2)} ${String(c.steps).padStart(5)} ` +
      `${String(c.outputs).padStart(4)} ${c.maxRisk.padEnd(12)} ${classes}`,
  );
}
console.log('');
