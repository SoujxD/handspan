/**
 * Evidence capture for the submission.
 *
 * Replays a discovered capability across every result class the contract can
 * produce, and writes a summary index next to the per-run evidence
 * directories. Everything here is deterministic and makes zero model calls —
 * running it does not cost anything and produces identical results each time.
 *
 *   npx tsx scripts/capture-evidence.ts <capabilityId>
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlaywrightSurface } from '../src/surface/web/playwright-surface.js';
import { SessionLease } from '../src/control/lease.js';
import { EvidenceRecorder } from '../src/evidence/recorder.js';
import { replay } from '../src/replay/engine.js';
import { detemplatize } from '../src/agent/compiler.js';
import { buildRedactor, loadPolicy, newRunId, PATHS, runtimeConfig } from '../src/config.js';
import { CapabilityStore } from '../src/catalog/store.js';
import { summarize, type ReplayResult } from '../src/types/result.js';

const capabilityId = process.argv[2];
if (!capabilityId) {
  console.error('usage: npx tsx scripts/capture-evidence.ts <capabilityId> [memberIdParamName]');
  process.exit(2);
}
const memberParam = process.argv[3] ?? 'memberId';
/** Extra `k=v` inputs for capabilities that need more than a record id. */
const extraInputs: Record<string, string> = {};
for (const arg of process.argv.slice(4)) {
  const i = arg.indexOf('=');
  if (i > 0) extraInputs[arg.slice(0, i)] = arg.slice(i + 1);
}

const cfg = runtimeConfig();
const store = new CapabilityStore(PATHS.artifacts);
const cap = store.load(capabilityId);

const setFault = (mode: string) =>
  fetch(`${cfg.targetAppBase}/__control/fault?mode=${mode}`, { method: 'POST' });

interface Case {
  slug: string;
  title: string;
  why: string;
  fault: string;
  tenant: string;
  inputs: Record<string, string>;
}

const CASES: Case[] = [
  {
    slug: '01-success',
    title: 'Happy path',
    why: 'The capability reaches its checkpoint and returns typed outputs.',
    fault: 'none',
    tenant: cap.surface.recordedOnTenant,
    inputs: { [memberParam]: '12345' },
  },
  {
    slug: '02-success-different-input',
    title: 'Different input, same capability',
    why: 'Proves replay is parameterised rather than replaying memorised values.',
    fault: 'none',
    tenant: cap.surface.recordedOnTenant,
    inputs: { [memberParam]: '20881' },
  },
  {
    slug: '03-business-outcome-not-found',
    title: 'Business outcome: no such member',
    why: 'A legitimate answer the caller needs. Reported as an outcome, exit code 0 — NOT a failure.',
    fault: 'none',
    tenant: cap.surface.recordedOnTenant,
    inputs: { [memberParam]: '99999' },
  },
  {
    slug: '04-business-outcome-restricted',
    title: 'Business outcome: permission denied',
    why: 'A RESTRICTED record. Also an answer, not a crash.',
    fault: 'none',
    tenant: cap.surface.recordedOnTenant,
    inputs: { [memberParam]: '33417' },
  },
  {
    slug: '05-recoverable-interstitial',
    title: 'Recoverable: unexpected interstitial',
    why: 'An advisory screen appears on every request. The engine dismisses it, verifies the recovery made progress, and continues.',
    fault: 'unexpected_dialog',
    tenant: cap.surface.recordedOnTenant,
    inputs: { [memberParam]: '12345' },
  },
  {
    slug: '06-recoverable-slow-load',
    title: 'Recoverable: degraded/slow application',
    why: 'Six seconds per request. Condition-based waiting rides it out where a fixed sleep would fail.',
    fault: 'slow_load',
    tenant: cap.surface.recordedOnTenant,
    inputs: { [memberParam]: '12345' },
  },
  {
    slug: '07-hard-failure-server-error',
    title: 'Hard failure: application server error',
    why: 'Classified as an application fault, with expected/observed and evidence pointers for debugging.',
    fault: 'server_error',
    tenant: cap.surface.recordedOnTenant,
    inputs: { [memberParam]: '12345' },
  },
  {
    slug: '08-invalid-input',
    title: 'Rejected before touching the surface',
    why: 'A missing required input fails the declared contract at the boundary, not halfway through a flow.',
    fault: 'none',
    tenant: cap.surface.recordedOnTenant,
    inputs: {},
  },
];

// Cross-tenant only runs if a second binding exists.
if (cap.tenants.length > 1) {
  const other = cap.tenants.find((t) => t.tenantId !== cap.surface.recordedOnTenant)!;
  CASES.push({
    slug: '09-cross-tenant',
    title: `Cross-tenant reuse: ${other.tenantId}`,
    why: 'Same artifact at a second institution running the same vendor product, via a label overlay. No re-recording.',
    fault: 'none',
    tenant: other.tenantId,
    inputs: { [memberParam]: '12345' },
  });
}

interface Row {
  slug: string;
  title: string;
  why: string;
  status: string;
  detail: string;
  runId: string;
  evidenceDir: string;
  llmCalls: number;
}

const rows: Row[] = [];

console.log(`\n  Capturing evidence for ${cap.id} v${cap.version}\n  ${'─'.repeat(92)}`);

for (const c of CASES) {
  await setFault(c.fault);

  const policy = loadPolicy();
  const redactor = buildRedactor(policy);
  const runId = newRunId('replay');
  const evidence = new EvidenceRecorder(runId, PATHS.evidence, redactor, false);
  const lease = new SessionLease(runId);
  const tenant = cap.tenants.find((t) => t.tenantId === c.tenant)!;

  const inputs: Record<string, string> = { ...extraInputs, ...c.inputs };
  // Credentials come from the environment, never from the artifact.
  for (const p of cap.inputs) {
    if (inputs[p.name] !== undefined) continue;
    if (/user|login/i.test(p.name)) inputs[p.name] = process.env['DEMO_USERNAME'] ?? 'teller01';
    else if (/pass|pwd|secret/i.test(p.name)) inputs[p.name] = process.env['DEMO_PASSWORD'] ?? 'demo-pass-1234';
  }
  // Case 08 deliberately omits every input, to exercise contract validation.
  if (c.slug === '08-invalid-input') for (const k of Object.keys(inputs)) delete inputs[k];

  const surface = await PlaywrightSurface.launch({
    lease,
    headless: true,
    defaultTimeoutMs: policy.limits.defaultActionTimeoutMs,
  });

  let result: ReplayResult;
  try {
    await surface.act({ kind: 'navigate', url: detemplatize(cap.surface.entryUrl, tenant.baseUrl) });
    result = await replay({
      capability: cap,
      tenantId: c.tenant,
      inputs,
      surface,
      policy,
      redactor,
      evidence,
      lease,
      runId,
      mode: 'attended',
      allowEscalation: false,
    });
  } finally {
    await surface.close();
  }

  evidence.saveJson('result', result);
  evidence.saveJson('scenario', { slug: c.slug, title: c.title, why: c.why, fault: c.fault, tenant: c.tenant });

  const detail =
    result.status === 'success'
      ? Object.entries(result.outputs).map(([k, v]) => `${k}=${v.value}`).join(' ')
      : result.status === 'outcome'
        ? `${result.outcome}`
        : result.status === 'failure'
          ? `${result.failure.kind}`
          : `${result.interventionId}`;

  rows.push({
    slug: c.slug,
    title: c.title,
    why: c.why,
    status: result.status,
    detail,
    runId,
    evidenceDir: evidence.dir.replace(/\\/g, '/').split('/evidence/')[1] ?? evidence.dir,
    llmCalls: result.meta.llmCalls,
  });

  console.log(`  ${c.slug.padEnd(30)} ${result.status.padEnd(10)} ${detail}`);
  console.log(`  ${''.padEnd(30)} ${summarize(result)}`);
}

await setFault('none');

// --- index -----------------------------------------------------------------
const lines: string[] = [];
lines.push(`# Evidence — \`${cap.id}\` v${cap.version}`);
lines.push('');
lines.push(`> ${cap.description}`);
lines.push('');
lines.push(
  `Discovered by **${cap.provenance.model}** on ${cap.provenance.discoveredAt} ` +
    `(discovery run \`${cap.provenance.discoveryRunId}\`). Content hash \`${cap.provenance.contentHash}\`.`,
);
lines.push('');
lines.push('**Every replay below made 0 model calls.** That is the point of the artifact.');
lines.push('');
lines.push('| # | Scenario | Result | Detail | Model calls | Evidence |');
lines.push('|---|---|---|---|---|---|');
for (const r of rows) {
  lines.push(
    `| ${r.slug.split('-')[0]} | **${r.title}**<br><sub>${r.why}</sub> | \`${r.status}\` | ${r.detail} | ${r.llmCalls} | [\`${r.evidenceDir}\`](./${r.evidenceDir}) |`,
  );
}
lines.push('');
lines.push('Each evidence directory contains `run.jsonl` (structured log), `result.json`');
lines.push('(the full result contract), `scenario.json`, and — on failure — a screenshot,');
lines.push('a DOM dump, and the normalized accessibility snapshot the resolver was looking at.');
lines.push('');

const indexPath = join(PATHS.evidence, `INDEX-${cap.id}.md`);
writeFileSync(indexPath, lines.join('\n'), 'utf8');

console.log(`  ${'─'.repeat(92)}`);
console.log(`\n  Index written: ${indexPath}\n`);
