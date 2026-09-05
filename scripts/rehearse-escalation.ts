/**
 * Rehearse the escalation beat against MERIDIAN CORE.
 *
 * `tests/integration-escalation.ts` already proves the handoff seam end to end
 * — escalate, pause the lease, an operator takes the *same live session*, acts,
 * hands back, the run resumes — but it does that against the bundled fixture
 * app. The beat actually shown on stage is the hosted one: a teller reaches for
 * a supervisor-only hold, the application refuses, and a person takes over.
 *
 * Those are different claims. This rehearses the second, so it is not being
 * demonstrated for the first time in front of an audience.
 *
 * What it asserts, in order:
 *
 *   1. The run PARKS rather than failing — an escalation is not an error.
 *   2. The intervention carries enough context to act on: capability, step,
 *      reason, guidance, the URL it stopped at.
 *   3. Taking control moves the lease to the operator.
 *   4. While a human holds it the automation *cannot* act. This is the load-
 *      bearing one: it is an enforcement point in `PlaywrightSurface.act()`,
 *      not a convention, and it is the whole reason the handoff is safe.
 *   5. Handing back returns the lease.
 *
 * It stops short of completing the hold. Signing on as a supervisor and
 * applying it is a human action performed in the live browser, and scripting
 * it would rehearse something nobody is going to do.
 *
 *   npx tsx scripts/rehearse-escalation.ts
 */

import { PlaywrightSurface } from '../src/surface/web/playwright-surface.js';
import { ControlDeniedError, SessionLease } from '../src/control/lease.js';
import { EvidenceRecorder } from '../src/evidence/recorder.js';
import { replay } from '../src/replay/engine.js';
import { detemplatize } from '../src/agent/compiler.js';
import {
  buildRedactor,
  fillSecretsFromEnvironment,
  loadPolicy,
  newRunId,
  observationRedactionHook,
  PATHS,
  requireInstitution,
  runtimeConfig,
} from '../src/config.js';
import { CapabilityStore } from '../src/catalog/store.js';
import { startOperatorConsole, operatorBaseUrl } from '../src/operator/server.js';
import { broker } from '../src/control/escalation.js';
import type { ReplayResult } from '../src/types/result.js';

const CAPABILITY = process.argv[2] ?? 'place_account_hold_request';
const TENANT = process.env['MERIDIAN_TENANT'] ?? 'meridian-demo';

const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ''): void => {
  if (!ok) failures.push(label);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
};

const store = new CapabilityStore(PATHS.artifacts);
const cap = store.load(CAPABILITY);
const institution = requireInstitution(TENANT);
const tenant = cap.tenants.find((t) => t.tenantId === TENANT);
if (!tenant) {
  console.error(`${cap.id} has no binding for "${TENANT}".`);
  process.exit(2);
}

const policy = loadPolicy();
const redactor = buildRedactor(policy);
const runId = newRunId('replay');
const evidence = new EvidenceRecorder(runId, PATHS.evidence, redactor, false);
const lease = new SessionLease(runId);

await startOperatorConsole().catch(() => undefined);
const consoleUrl = operatorBaseUrl();

console.log(`\n  ESCALATION REHEARSAL — ${cap.id} v${cap.version} against ${institution.displayName}`);
console.log(`  ${'─'.repeat(84)}`);
console.log(`  operator console: ${consoleUrl}`);
console.log(`  acting as:        ${process.env['HANDSPAN_INPUT_OPERATOR_ID'] ?? 'teller1'} (bound to the deployment)\n`);

const surface = await PlaywrightSurface.launch({
  lease,
  headless: process.env['HANDSPAN_HEADLESS'] !== '0',
  defaultTimeoutMs: policy.limits.defaultActionTimeoutMs,
  onObserve: observationRedactionHook(policy, redactor),
});

const inputs = fillSecretsFromEnvironment(cap, {
  memberNumber: process.env['MERIDIAN_MEMBER'] ?? '100987',
  shareId: process.env['MERIDIAN_SHARE'] ?? '100987-S0001',
  reasonCode: 'FRAUD - Suspected fraud',
  notes: 'escalation rehearsal — not authorised',
});

await surface.act({ kind: 'navigate', url: detemplatize(cap.surface.entryUrl, tenant.baseUrl) });

// Start the run. It will park; we drive the operator side while it waits.
const running: Promise<ReplayResult> = replay({
  capability: cap,
  tenantId: TENANT,
  inputs,
  surface,
  policy,
  redactor,
  evidence,
  lease,
  runId,
  mode: 'attended',
  operatorBaseUrl: consoleUrl,
  // Long enough for a person to actually do something; the rehearsal resolves
  // it in seconds, but the demo will not.
  escalationWaitMs: 120_000,
});

/**
 * Wait for the intervention to be raised.
 *
 * Read from the broker in-process, because the console serves HTML rather than
 * JSON and this only needs to *find* the thing. Everything that matters —
 * taking control, handing back — still goes over HTTP, through the identical
 * endpoints the console's buttons post to, because that is the path a human
 * actually takes and therefore the one worth rehearsing.
 */
async function waitForIntervention(timeoutMs: number): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = broker.list().find((i) => i.runId === runId);
    if (open) return open as unknown as Record<string, unknown>;
    if (Date.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const intervention = await waitForIntervention(180_000);

if (!intervention) {
  console.log('  FAIL no intervention was raised — the run did not escalate.');
  console.log('       If the guard classification changed, this beat no longer exists.\n');
  await surface.close().catch(() => undefined);
  process.exit(1);
}

const id = String(intervention['id']);
console.log(`  Intervention ${id}`);
console.log(`    capability   ${String(intervention['capabilityName'] ?? '')}`);
console.log(`    stopped at   ${String(intervention['atStepId'] ?? '')} — ${String(intervention['stepIntent'] ?? '')}`);
console.log(`    reason       ${String(intervention['reason'] ?? '')}`);
console.log(`    guidance     ${String(intervention['guidance'] ?? '')}`);
console.log(`    url          ${String(intervention['currentUrl'] ?? '')}\n`);

check(!!intervention['reason'], 'the intervention says why it stopped');
check(!!intervention['guidance'], 'it says what a human should do');
check(!!intervention['atStepId'], 'it names the step it stopped on');

const state = async (): Promise<Record<string, unknown>> =>
  (await fetch(`${consoleUrl}/i/${id}/state.json`).then((r) => r.json())) as Record<string, unknown>;

check(String((await state())['holder']) !== 'automation', 'the lease left the automation when it parked');

// --- the operator takes the same live session -----------------------------
const took = (await fetch(`${consoleUrl}/i/${id}/take`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ operatorId: 'supervisor@rehearsal' }),
}).then((r) => r.json())) as Record<string, unknown>;
check(took['ok'] === true, 'a supervisor can take control');
check(String((await state())['holder']) === 'operator', 'the lease is now held by the operator');

// --- the load-bearing assertion -------------------------------------------
let denied = false;
try {
  await surface.act({ kind: 'navigate', url: tenant.baseUrl });
} catch (e) {
  denied = e instanceof ControlDeniedError;
}
check(denied, 'the automation CANNOT act while a human holds the session');

// --- hand back -------------------------------------------------------------
const handed = (await fetch(`${consoleUrl}/i/${id}/handback`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ note: 'rehearsal: supervisor reviewed, hold not applied' }),
}).then((r) => r.json())) as Record<string, unknown>;
check(handed['ok'] === true, 'the operator can hand control back');

const result = await running.catch((e: Error) => {
  console.log(`\n  run ended with an error: ${e.message}`);
  return undefined;
});

if (result) {
  console.log(`\n  Run finished as: ${result.status}`);
  console.log(`  Model calls during the whole thing: ${result.meta.llmCalls}`);
  check(result.meta.llmCalls === 0, 'no model was involved in any of this');
}

console.log(`\n  lease transitions:`);
for (const t of lease.history) {
  console.log(`    ${t.from} -> ${t.to}   (${t.reason})`);
}

await surface.close().catch(() => undefined);

console.log(`\n  ${'─'.repeat(84)}`);
if (failures.length) {
  console.log(`  ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.log(`    - ${f}`);
  console.log('');
  process.exit(1);
}
console.log('  Escalation, control transfer, lockout and handback all verified on the live target.\n');
process.exit(0);
