/**
 * Outcome-detector verification.
 *
 * A declared business outcome is a claim: "when this happens, you will get this
 * code back". Nothing checks that claim at discovery time, and the failure mode
 * is quiet — a detector written from remembered phrasing rather than observed
 * text never matches, so the capability *looks* like it handles "no such
 * member" while actually reporting it as a checkpoint failure.
 *
 * This replays the capability against inputs and fault modes chosen to provoke
 * each declared outcome, and reports which ones actually fired. Detectors that
 * never fire are listed as UNVERIFIED — not necessarily wrong (some states are
 * genuinely hard to provoke), but not evidence of anything either.
 *
 * Zero model calls, so it is free to run as often as you like.
 *
 *   npx tsx scripts/verify-outcomes.ts <capabilityId> [k=v ...]
 */

import { PlaywrightSurface } from '../src/surface/web/playwright-surface.js';
import { SessionLease } from '../src/control/lease.js';
import { EvidenceRecorder } from '../src/evidence/recorder.js';
import { replay } from '../src/replay/engine.js';
import { detemplatize } from '../src/agent/compiler.js';
import { buildRedactor, loadPolicy, newRunId, PATHS, runtimeConfig } from '../src/config.js';
import { CapabilityStore } from '../src/catalog/store.js';
import type { ReplayResult } from '../src/types/result.js';

const capabilityId = process.argv[2];
if (!capabilityId) {
  console.error('usage: npx tsx scripts/verify-outcomes.ts <capabilityId> [k=v ...]');
  process.exit(2);
}

const extra: Record<string, string> = {};
for (const arg of process.argv.slice(3)) {
  const i = arg.indexOf('=');
  if (i > 0) extra[arg.slice(0, i)] = arg.slice(i + 1);
}

const cfg = runtimeConfig();
const store = new CapabilityStore(PATHS.artifacts);
const cap = store.load(capabilityId);
const setFault = (m: string) => fetch(`${cfg.targetAppBase}/__control/fault?mode=${m}`, { method: 'POST' });

/** Probes chosen to provoke states the mock application can actually produce. */
const PROBES: Array<{ name: string; fault: string; overrides: Record<string, string> }> = [
  { name: 'nonexistent record', fault: 'none', overrides: { memberId: '99999' } },
  { name: 'restricted record', fault: 'none', overrides: { memberId: '33417' } },
  // 77002 holds only a CERTIFICATE — the natural way to reach a
  // "member exists but has no savings share" state without faulting anything.
  { name: 'member without a savings share', fault: 'none', overrides: { memberId: '77002' } },
  { name: 'dormant record', fault: 'none', overrides: { memberId: '77002' } },
  { name: 'unexpected interstitial', fault: 'unexpected_dialog', overrides: {} },
  { name: 'session timeout', fault: 'session_timeout', overrides: {} },
  { name: 'server error', fault: 'server_error', overrides: {} },
  { name: 'validation error', fault: 'validation', overrides: {} },
  { name: 'bad credentials', fault: 'none', overrides: { password: 'definitely-wrong' } },
  { name: 'blank search criteria', fault: 'none', overrides: { memberId: '' } },
];

const fired = new Map<string, string[]>();
const observed: string[] = [];

console.log(`\n  Outcome verification — ${cap.id} v${cap.version}\n  ${'─'.repeat(88)}`);

for (const probe of PROBES) {
  await setFault(probe.fault);

  const policy = loadPolicy();
  const redactor = buildRedactor(policy);
  const runId = newRunId('verify');
  const evidence = new EvidenceRecorder(runId, PATHS.evidence, redactor, false);
  const lease = new SessionLease(runId);
  const tenant = cap.tenants.find((t) => t.tenantId === cap.surface.recordedOnTenant)!;

  const inputs: Record<string, string> = { memberId: '12345', ...extra, ...probe.overrides };
  for (const p of cap.inputs) {
    if (inputs[p.name] !== undefined) continue;
    if (/user|login/i.test(p.name)) inputs[p.name] = process.env['DEMO_USERNAME'] ?? 'teller01';
    else if (/pass|pwd|secret/i.test(p.name)) inputs[p.name] = process.env['DEMO_PASSWORD'] ?? 'demo-pass-1234';
    // Fall back to the artifact's own examples. Without this, a capability
    // with parameters beyond the member id fails pre-flight on every probe and
    // reports 0/N — which reads as "every detector is broken" when the truth is
    // "the browser was never opened". A verification pass that can fail in a
    // way indistinguishable from the thing it verifies is worse than none.
    else if (p.example !== undefined) inputs[p.name] = String(p.example);
    else if (p.enumValues?.[0] !== undefined) inputs[p.name] = p.enumValues[0];
  }

  const missing = cap.inputs.filter((p) => p.required && inputs[p.name] === undefined).map((p) => p.name);
  if (missing.length) {
    console.error(`\n  Cannot probe: no value for required input(s) ${missing.join(', ')}.`);
    console.error(`  Pass them on the command line, e.g. \`${missing[0]}=<value>\`.\n`);
    process.exit(2);
  }

  const surface = await PlaywrightSurface.launch({
    lease,
    headless: true,
    defaultTimeoutMs: policy.limits.defaultActionTimeoutMs,
  });

  let result: ReplayResult;
  try {
    await surface.act({ kind: 'navigate', url: detemplatize(cap.surface.entryUrl, tenant.baseUrl) });
    result = await replay({
      capability: cap, tenantId: tenant.tenantId, inputs, surface, policy, redactor,
      evidence, lease, runId, mode: 'attended', allowEscalation: false, escalationWaitMs: 3000,
    });
  } catch (e) {
    console.log(`  ${probe.name.padEnd(26)} ERROR  ${(e as Error).message.slice(0, 60)}`);
    await surface.close();
    continue;
  } finally {
    await surface.close();
  }

  // Which guards fired is recorded in the trace as `recovered` entries, and a
  // terminal outcome shows up as the result status.
  // A declared rule can end a run in any of three shapes, and all three count
  // as the detector having fired: a business outcome, a `hard` rule surfacing
  // as a failure, or an `escalate` rule parking on a human. Counting only the
  // first made two working detectors look dead.
  const codes = new Set<string>();
  if (result.status === 'outcome') codes.add(result.outcome);
  if (result.status === 'failure' && result.failure.outcomeCode) codes.add(result.failure.outcomeCode);
  if (result.status === 'escalated' && result.outcomeCode) codes.add(result.outcomeCode);
  for (const t of result.trace) if (t.recovery) codes.add(t.recovery.outcomeCode);

  for (const c of codes) {
    fired.set(c, [...(fired.get(c) ?? []), probe.name]);
  }

  const summary =
    result.status === 'outcome'
      ? `outcome=${result.outcome}`
      : result.status === 'failure'
        ? `failure=${result.failure.kind}`
        : result.status;
  observed.push(`${probe.name} -> ${summary}`);
  console.log(`  ${probe.name.padEnd(26)} ${summary}${codes.size ? `  [fired: ${[...codes].join(', ')}]` : ''}`);
}

await setFault('none');

console.log(`  ${'─'.repeat(88)}\n`);
console.log('  Declared outcome detectors:\n');

let unverified = 0;
for (const rule of cap.outcomes) {
  const hits = fired.get(rule.code);
  if (hits) {
    console.log(`  VERIFIED    ${rule.code.padEnd(26)} ${rule.classification.padEnd(12)} fired on: ${hits.join(', ')}`);
  } else {
    unverified++;
    console.log(`  UNVERIFIED  ${rule.code.padEnd(26)} ${rule.classification.padEnd(12)} never fired in any probe`);
  }
}

console.log(
  `\n  ${cap.outcomes.length - unverified}/${cap.outcomes.length} declared detectors verified against the live application.`,
);
if (unverified) {
  console.log(
    `  UNVERIFIED detectors are not necessarily wrong — some states are hard to provoke — but they are\n` +
      `  not evidence of anything either. A detector written from remembered phrasing rather than observed\n` +
      `  text is the most common way a capability ships looking correct and behaving otherwise.\n`,
  );
}
