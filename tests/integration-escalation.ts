/**
 * Human-in-the-loop escalation: end-to-end.
 *
 * Proves the whole seam actually works rather than existing as a TODO:
 *
 *   1. A declared `escalate` outcome fires mid-replay (session expiry).
 *   2. An intervention is raised carrying context, and the lease is PAUSED —
 *      at which point the automation physically cannot act.
 *   3. An operator takes control of the SAME live session.
 *   4. The operator fixes the problem and their actions are recorded.
 *   5. Control is handed back, the automation resumes on that same session,
 *      and the run completes.
 *
 * The operator here drives through the console's HTTP API rather than by hand,
 * which is what makes this runnable in CI. It goes through the identical lease
 * transitions a human clicking the buttons would.
 *
 *   npm run target                              # in one terminal
 *   npx tsx tests/integration-escalation.ts     # in another
 */

import { PlaywrightSurface } from '../src/surface/web/playwright-surface.js';
import { SessionLease, ControlDeniedError } from '../src/control/lease.js';
import { EvidenceRecorder } from '../src/evidence/recorder.js';
import { replay } from '../src/replay/engine.js';
import { detemplatize } from '../src/agent/compiler.js';
import { buildRedactor, loadPolicy, newRunId, PATHS, runtimeConfig } from '../src/config.js';
import { summarize } from '../src/types/result.js';
import { parseCapability } from '../src/types/artifact.js';
import { referenceCapability } from './fixtures/reference-capability.js';
import { startOperatorConsole, operatorBaseUrl } from '../src/operator/server.js';
import { broker } from '../src/control/escalation.js';

const cfg = runtimeConfig();
const NORTHSTAR = `${cfg.targetAppBase}/t/northstar`;

const setFault = (mode: string) =>
  fetch(`${cfg.targetAppBase}/__control/fault?mode=${mode}`, { method: 'POST' });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function step(n: number, text: string): void {
  console.log(`\n  ${n}. ${text}`);
}

await startOperatorConsole();
const console_ = operatorBaseUrl();

const policy = loadPolicy();
const redactor = buildRedactor(policy);
const runId = newRunId('verify');
const evidence = new EvidenceRecorder(runId, PATHS.evidence, redactor, false);
const lease = new SessionLease(runId);
const cap = parseCapability(referenceCapability(NORTHSTAR));

console.log('\n  Human-in-the-loop escalation — end to end');
console.log(`  ${'─'.repeat(78)}`);
console.log(`  operator console: ${console_}`);

// The app will report the session as expired, which the capability declares as
// an `escalate` outcome: software cannot fix it, a person can.
await setFault('session_timeout');
step(1, 'Injected a session timeout. The capability declares this as `escalate`.');

const surface = await PlaywrightSurface.launch({
  lease,
  headless: true,
  defaultTimeoutMs: policy.limits.defaultActionTimeoutMs,
});

let problems = 0;
const fail = (m: string) => {
  problems++;
  console.log(`     FAIL  ${m}`);
};

try {
  await surface.act({ kind: 'navigate', url: detemplatize(cap.surface.entryUrl, NORTHSTAR) });

  const running = replay({
    capability: cap,
    tenantId: 'northstar',
    inputs: {
      memberId: '12345',
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
    allowEscalation: true,
    escalationWaitMs: 120_000,
    operatorBaseUrl: console_,
  });

  // --- wait for the intervention to be raised ------------------------------
  let intervention = broker.list()[0];
  for (let i = 0; i < 120 && !intervention; i++) {
    await sleep(500);
    intervention = broker.list()[0];
  }
  if (!intervention) throw new Error('No intervention was raised within 60s.');

  step(2, `Intervention ${intervention.id} raised.`);
  console.log(`     trigger:  ${intervention.trigger}`);
  console.log(`     reason:   ${intervention.reason}`);
  console.log(`     guidance: ${intervention.guidance}`);
  console.log(`     at step:  ${intervention.atStepId} — ${intervention.stepIntent}`);
  console.log(`     url:      ${intervention.currentUrl}`);
  console.log(`     evidence: ${intervention.screenshotPath}`);

  // --- the lease must be paused: nobody drives -----------------------------
  step(3, `Lease state is "${lease.current.status}" — holder: ${lease.holder}`);
  if (lease.holder !== 'nobody') fail(`expected nobody to hold the lease, got "${lease.holder}"`);

  try {
    await surface.act({ kind: 'navigate', url: `${NORTHSTAR}/home` });
    fail('automation was able to act while the session was paused — the lease is not enforced');
  } catch (e) {
    if (e instanceof ControlDeniedError) {
      console.log(`     automation blocked at the surface: ${e.message}`);
    } else {
      fail(`expected ControlDeniedError, got ${(e as Error).message}`);
    }
  }

  // --- operator takes control of the SAME live session ---------------------
  const take = await fetch(`${console_}/i/${intervention.id}/take`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operatorId: 'sam.ops@northstar.test' }),
  }).then((r) => r.json());
  step(4, `Operator took control (${take.status}). Lease holder: ${lease.holder}`);
  if (lease.holder !== 'operator') fail(`expected operator to hold the lease, got "${lease.holder}"`);

  try {
    await surface.act({ kind: 'navigate', url: `${NORTHSTAR}/home` });
    fail('automation acted while the OPERATOR held the lease — this is the unsafe case');
  } catch (e) {
    if (e instanceof ControlDeniedError) console.log(`     automation still blocked: ${e.name}`);
    else fail(`expected ControlDeniedError, got ${(e as Error).message}`);
  }

  // --- the operator fixes the problem on the live session ------------------
  //
  // Note HOW this drives the page: `surface.livePage`, not `surface.act()`.
  // That is faithful, not a shortcut — a human operates the browser directly,
  // while the automation's action API stays lease-blocked (asserted above).
  // It is the same window, same context, same cookies; nothing was torn down
  // and nothing was re-created.
  await setFault('none');
  broker.recordHumanAction(intervention.id, {
    at: new Date().toISOString(),
    type: 'note',
    target: 'session re-authenticated by operator',
  });

  await surface.livePage.goto(
    `${NORTHSTAR}/shell?to=${encodeURIComponent('/t/northstar/member/search')}`,
    { waitUntil: 'domcontentloaded' },
  );
  broker.recordHumanAction(intervention.id, {
    at: new Date().toISOString(),
    type: 'click',
    role: 'link',
    label: 'Member Servicing',
    target: 'link "Member Servicing"',
    url: `${NORTHSTAR}/member/search`,
  });

  step(5, 'Operator drove the live session back to Member Search; actions recorded.');
  console.log(`     live session now at: ${surface.livePage.url()}`);

  // --- hand control back ---------------------------------------------------
  const back = await fetch(`${console_}/i/${intervention.id}/handback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: 're-authenticated the servicing session' }),
  }).then((r) => r.json());
  step(6, `Operator handed control back (${back.status}).`);

  const result = await running;
  step(7, `Automation resumed on the same session and finished: ${summarize(result)}`);

  const item = broker.get(intervention.id)!;
  console.log(`\n     recorded operator actions: ${item.humanActions.length}`);
  for (const a of item.humanActions) console.log(`       - ${a.type}: ${a.target ?? a.url ?? ''}`);

  console.log('\n     lease transitions:');
  for (const e of lease.history) console.log(`       ${e.from} -> ${e.to}   (${e.reason})`);

  if (result.status !== 'success') {
    fail(`expected the resumed run to succeed, got ${result.status}`);
  }
  if (result.meta.llmCalls !== 0) fail(`escalation path made ${result.meta.llmCalls} model calls`);

  evidence.saveJson('escalation-result', { result, intervention: item, lease: lease.history });
} finally {
  await surface.close();
  await setFault('none');
}

console.log(`\n  ${'─'.repeat(78)}`);
if (problems) {
  console.log(`  ${problems} problem(s) found.\n`);
  process.exit(1);
}
console.log('  Escalation, control transfer, and resume all verified.\n');
process.exit(0);
