/**
 * Replay engine integration check.
 *
 * Drives the real browser against the real mock application, in every fault
 * mode, and asserts that each produces the *correct shape* of result. This is
 * the test that would catch the taxonomy collapsing — a "no such member" page
 * being reported as a failure, or a server error being reported as a business
 * outcome.
 *
 * Runs with no API key: replay never calls a model.
 *
 *   npm run target                            # in one terminal
 *   npx tsx tests/integration-replay.ts       # in another
 */

import { PlaywrightSurface } from '../src/surface/web/playwright-surface.js';
import { SessionLease } from '../src/control/lease.js';
import { EvidenceRecorder } from '../src/evidence/recorder.js';
import { replay } from '../src/replay/engine.js';
import { detemplatize } from '../src/agent/compiler.js';
import { buildRedactor, loadPolicy, newRunId, PATHS, runtimeConfig } from '../src/config.js';
import { summarize, type ReplayResult } from '../src/types/result.js';
import { parseCapability } from '../src/types/artifact.js';
import { lakeshoreBinding, referenceCapability } from './fixtures/reference-capability.js';

const cfg = runtimeConfig();
const NORTHSTAR = `${cfg.targetAppBase}/t/northstar`;
const LAKESHORE = `${cfg.targetAppBase}/t/lakeshore`;

async function setFault(mode: string): Promise<void> {
  await fetch(`${cfg.targetAppBase}/__control/fault?mode=${mode}`, { method: 'POST' });
}

interface Scenario {
  name: string;
  fault: string;
  tenant: string;
  memberId: string;
  expect: (r: ReplayResult) => string | null;
}

const expectSuccess =
  (balance?: number) =>
  (r: ReplayResult): string | null => {
    if (r.status !== 'success') return `expected success, got ${r.status}`;
    if (balance !== undefined && r.outputs['savingsBalance']?.value !== balance) {
      return `expected savingsBalance ${balance}, got ${r.outputs['savingsBalance']?.value}`;
    }
    // PII must be extracted (so the flow works) but never returned raw.
    const name = r.outputs['memberName'];
    if (name && !name.redacted) return 'memberName is pii and should have been redacted on the way out';
    return null;
  };

const expectOutcome =
  (code: string) =>
  (r: ReplayResult): string | null => {
    if (r.status !== 'outcome') return `expected business outcome, got ${r.status}`;
    if (r.outcome !== code) return `expected outcome "${code}", got "${r.outcome}"`;
    return null;
  };

const expectFailure =
  (kind: string) =>
  (r: ReplayResult): string | null => {
    if (r.status !== 'failure') return `expected failure, got ${r.status}`;
    if (r.failure.kind !== kind) return `expected failure kind "${kind}", got "${r.failure.kind}"`;
    return null;
  };

const SCENARIOS: Scenario[] = [
  {
    name: 'happy path — member with savings + checking',
    fault: 'none',
    tenant: 'northstar',
    memberId: '12345',
    expect: expectSuccess(18432.07),
  },
  {
    name: 'happy path — a DIFFERENT member (proves it is not replaying memorised values)',
    fault: 'none',
    tenant: 'northstar',
    memberId: '20881',
    expect: expectSuccess(55023.1),
  },
  {
    name: 'business outcome — no such member (must NOT be a failure)',
    fault: 'none',
    tenant: 'northstar',
    memberId: '99999',
    expect: expectOutcome('member_not_found'),
  },
  {
    name: 'business outcome — permission denied on a RESTRICTED record',
    fault: 'none',
    tenant: 'northstar',
    memberId: '33417',
    expect: expectOutcome('member_access_restricted'),
  },
  {
    name: 'recoverable — unexpected interstitial is dismissed and the run continues',
    fault: 'unexpected_dialog',
    tenant: 'northstar',
    memberId: '12345',
    expect: expectSuccess(18432.07),
  },
  {
    name: 'recoverable — slow app; condition-based waiting rides it out',
    fault: 'slow_load',
    tenant: 'northstar',
    memberId: '12345',
    expect: expectSuccess(18432.07),
  },
  {
    name: 'hard failure — application server error, classified as an app fault',
    fault: 'server_error',
    tenant: 'northstar',
    memberId: '12345',
    expect: expectFailure('surface_error'),
  },
  {
    name: 'cross-tenant — same artifact, different institution, via a label overlay',
    fault: 'none',
    tenant: 'lakeshore',
    memberId: '12345',
    expect: expectSuccess(18432.07),
  },
];

async function runOne(s: Scenario): Promise<{ ok: boolean; detail: string; result: ReplayResult }> {
  await setFault(s.fault);

  const policy = loadPolicy();
  const redactor = buildRedactor(policy);
  const runId = newRunId('verify');
  const evidence = new EvidenceRecorder(runId, PATHS.evidence, redactor, false);
  const lease = new SessionLease(runId);

  const cap = parseCapability({
    ...referenceCapability(NORTHSTAR),
    tenants: [...referenceCapability(NORTHSTAR).tenants, lakeshoreBinding(LAKESHORE)],
  });

  const tenant = cap.tenants.find((t) => t.tenantId === s.tenant)!;
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
      tenantId: s.tenant,
      inputs: {
        memberId: s.memberId,
        username: process.env['DEMO_USERNAME'] ?? 'teller01',
        password: process.env['DEMO_PASSWORD'] ?? 'demo-pass-1234',
      },
      surface,
      policy,
      redactor,
      evidence,
      lease,
      runId,
      mode: 'attended',
      // A parked run would hang this check forever; escalation has its own test.
      allowEscalation: false,
      escalationWaitMs: 5000,
    });
  } finally {
    await surface.close();
  }

  const problem = s.expect(result);
  return { ok: problem === null, detail: problem ?? summarize(result), result };
}

// ---------------------------------------------------------------------------

console.log('\n  Replay engine integration check — no model calls\n');
console.log(`  ${'─'.repeat(96)}`);

let passed = 0;
const failures: string[] = [];

for (const s of SCENARIOS) {
  process.stdout.write(`  ${s.name.padEnd(74)} `);
  try {
    const { ok, detail, result } = await runOne(s);
    if (ok) {
      passed++;
      console.log(`PASS  ${result.status}`);
      if (result.status === 'success') {
        const outs = Object.entries(result.outputs)
          .map(([k, v]) => `${k}=${v.value}`)
          .join(' ');
        console.log(`  ${''.padEnd(74)}       ${outs}`);
      } else if (result.status === 'outcome') {
        console.log(`  ${''.padEnd(74)}       ${result.outcome} (exit 0 — a valid answer)`);
      }
      // Prove the claim rather than asserting it.
      if (result.meta.llmCalls !== 0) failures.push(`${s.name}: made ${result.meta.llmCalls} model calls`);
    } else {
      console.log(`FAIL  ${detail}`);
      failures.push(`${s.name}: ${detail}`);
    }
  } catch (e) {
    console.log(`ERROR ${(e as Error).message}`);
    failures.push(`${s.name}: threw — ${(e as Error).message}`);
  }
}

await setFault('none');

console.log(`  ${'─'.repeat(96)}`);
console.log(`\n  ${passed}/${SCENARIOS.length} scenarios produced the expected result shape.`);
if (failures.length) {
  console.log('\n  Failures:');
  for (const f of failures) console.log(`    - ${f}`);
  process.exit(1);
}
console.log('  Every replay made 0 model calls.\n');
