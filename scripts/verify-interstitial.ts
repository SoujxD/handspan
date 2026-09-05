/**
 * Verify the recoverable class against the live target.
 *
 * §2.2 of the brief names three classes a replay must tell apart — business
 * outcomes, recoverable conditions, hard failures — and gives "dismiss a known
 * interstitial" as the example of the middle one. `?inject=maintenance` returns
 * a 503 page carrying a `Continue` button, which is exactly that.
 *
 * Every other outcome this system declares against MERIDIAN CORE is provoked by
 * an INPUT — a member that does not exist, an amount larger than the balance —
 * so `verify-outcomes.ts` can drive them by replaying with different arguments.
 * A maintenance interstitial is not reachable that way: it rides a navigation,
 * and the routes that render it are ones the flow reaches by clicking. That is
 * the same limitation that leaves four other detectors unverified, and it is
 * why this exists as a separate check rather than another probe.
 *
 * What it does verify, through the production code paths rather than a mock:
 *
 *   1. The detector's text matches the page the host actually serves. This is
 *      the failure that matters — a rule written from remembered phrasing never
 *      fires, and the capability *looks* like it handles the condition.
 *   2. The recovery target resolves, by the same deterministic resolver replay
 *      uses, with a real score and margin.
 *   3. Clicking it clears the state — so the recovery makes progress rather
 *      than looping, which is the property the engine checks before it allows
 *      a step to retry.
 *
 * What it does not cover is the engine's orchestration of those pieces, which
 * `tests/` already exercises against the fixture app. The claim here is narrower
 * and is the one that could not be made any other way: this rule, as written in
 * the artifact, matches this host, as it renders today.
 *
 *   npx tsx scripts/verify-interstitial.ts [capabilityId]
 */

import { PlaywrightSurface } from '../src/surface/web/playwright-surface.js';
import { SessionLease } from '../src/control/lease.js';
import { EvidenceRecorder } from '../src/evidence/recorder.js';
import { replay } from '../src/replay/engine.js';
import { detemplatize } from '../src/agent/compiler.js';
import { evaluateCondition } from '../src/replay/evaluate.js';
import { resolve as resolveTarget } from '../src/surface/web/resolver.js';
import { CapabilityStore } from '../src/catalog/store.js';
import {
  buildRedactor,
  fillSecretsFromEnvironment,
  loadPolicy,
  newRunId,
  observationRedactionHook,
  PATHS,
  requireInstitution,
} from '../src/config.js';

const CAPABILITY = process.argv[2] ?? 'member_share_balance_lookup';
const CODE = 'maintenance_interstitial';
const TENANT = process.env['MERIDIAN_TENANT'] ?? 'meridian-demo';
/** Any authenticated route renders it; a member page is the most ordinary. */
const PROBE_PATH = `/members/${process.env['MERIDIAN_MEMBER'] ?? '100234'}?inject=maintenance`;

const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ''): void => {
  if (!ok) failures.push(label);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
};

const store = new CapabilityStore(PATHS.artifacts);
const cap = store.loadForEdit(CAPABILITY);
const institution = requireInstitution(TENANT);
const tenant = cap.tenants.find((t) => t.tenantId === TENANT);
if (!tenant) {
  console.error(`${cap.id} has no binding for "${TENANT}".`);
  process.exit(2);
}

const rule = cap.outcomes.find((o) => o.code === CODE);
if (!rule) {
  console.error(`${cap.id} v${cap.version} declares no outcome "${CODE}".`);
  process.exit(2);
}

const policy = loadPolicy();
const redactor = buildRedactor(policy);
const runId = newRunId('verify');
const evidence = new EvidenceRecorder(runId, PATHS.evidence, redactor, false);
const lease = new SessionLease(runId);

console.log(`\n  RECOVERABLE-CLASS VERIFICATION — ${cap.id} v${cap.version} / ${CODE}`);
console.log(`  ${'─'.repeat(84)}`);
console.log(`  target    ${institution.displayName}`);
console.log(`  rule      ${rule.classification}, origin=${rule.origin}`);
console.log(`  probe     ${PROBE_PATH}\n`);

const surface = await PlaywrightSurface.launch({
  lease,
  headless: process.env['HANDSPAN_HEADLESS'] !== '0',
  defaultTimeoutMs: policy.limits.defaultActionTimeoutMs,
  onObserve: observationRedactionHook(policy, redactor),
});

try {
  // Sign on for real, by replaying the sign-on capability into this same
  // surface. The interstitial only renders for an authenticated session, and
  // faking the cookie would verify a page this system never actually reaches.
  const signOn = store.load('operator_sign_on');
  const signOnInputs = fillSecretsFromEnvironment(signOn, {
    branch: process.env['MERIDIAN_BRANCH'] ?? 'MAIN-001 - Main Office',
  });
  await surface.act({
    kind: 'navigate',
    url: detemplatize(signOn.surface.entryUrl, tenant.baseUrl),
  });
  const session = await replay({
    capability: signOn,
    tenantId: TENANT,
    inputs: signOnInputs,
    surface,
    policy,
    redactor,
    evidence,
    lease,
    runId,
    mode: 'attended',
    allowEscalation: false,
  });
  check(session.status === 'success', 'signed on, so the probe runs authenticated', session.status);
  if (session.status !== 'success') throw new Error('cannot verify without a session');

  // --- 1. does the declared text match what the host serves? ---------------
  await surface.act({ kind: 'navigate', url: `${tenant.baseUrl}${PROBE_PATH}` });
  const onFault = await surface.snapshot();
  const ctx = { snapshot: onFault, resolveOptions: { labelOverrides: tenant.labelOverrides } };

  check(
    evaluateCondition(rule.detect, ctx),
    'the detector fires on the page the host actually serves',
    `http ${onFault.lastStatus ?? '?'}`,
  );

  // --- 2. does the recovery target resolve? --------------------------------
  const recovery = rule.recovery;
  check(recovery?.do === 'click', 'the recovery is a click, as the surface notes recorded');

  if (recovery && recovery.do === 'click') {
    const res = resolveTarget(recovery.target, onFault.nodes, ctx.resolveOptions);
    check(
      res.ok,
      'the recovery control resolves deterministically',
      res.ok
        ? `score ${res.score}, runner-up ${res.runnerUpScore}`
        : `${res.reason}, best ${res.bestScore}`,
    );

    // --- 3. does clicking it actually clear the state? ---------------------
    if (res.ok) {
      await surface.act({ kind: 'click', handle: res.node.handle });
      const after = await surface.snapshot();
      check(
        !evaluateCondition(rule.detect, { ...ctx, snapshot: after }),
        'clicking it clears the interstitial — the recovery makes progress',
        `now at ${after.url.replace(tenant.baseUrl, '')}`,
      );
    }
  }
} finally {
  await surface.close().catch(() => undefined);
}

console.log(`\n  ${'─'.repeat(84)}`);
if (failures.length) {
  console.log(`  ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.log(`    - ${f}`);
  console.log('');
  process.exit(1);
}
console.log('  Recoverable class verified against the live host: detected, resolved, cleared.\n');
process.exit(0);
