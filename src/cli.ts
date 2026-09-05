#!/usr/bin/env node
/**
 * Handspan CLI.
 *
 * The command split mirrors the architectural split, and that is intentional:
 *
 *   discover   needs a model API key and a human watching. Produces a draft
 *              artifact. Runs once per flow, per product.
 *   replay     needs neither. Runs thousands of times. This is the production
 *              path an agent triggers.
 *
 * If `replay` ever needed a key, the design would have failed.
 */

import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PATHS,
  buildRedactor,
  loadPolicy,
  newRunId,
  requireAnthropicKey,
  runtimeConfig,
  requireInstitution,
  fillSecretsFromEnvironment,
  observationRedactionHook,
} from './config.js';
import { EvidenceRecorder } from './evidence/recorder.js';
import { SessionLease } from './control/lease.js';
import { PlaywrightSurface } from './surface/web/playwright-surface.js';
import { runDiscovery } from './agent/loop.js';
import { compile, detemplatize, hashCapability } from './agent/compiler.js';
import { CapabilityStore, toToolDefinition } from './catalog/store.js';
import type { Capability } from './types/artifact.js';
import { replay } from './replay/engine.js';
import { analyzeRun, renderReport, type DriftReport } from './replay/drift.js';
import {
  applyRenames,
  assistRename,
  isRepairable,
  refusalFor,
  renderProposal,
  type ProposedRename,
  type RepairProposal,
} from './repair/propose.js';
import { exitCodeFor, summarize, type ReplayResult } from './types/result.js';
import { operatorBaseUrl, startOperatorConsole } from './operator/server.js';
import { startCatalog } from './catalog/server.js';

const program = new Command();
program
  .name('handspan')
  .description('Computer-use automation: discover once with a model, replay deterministically without one.')
  .version('0.1.0');

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

program
  .command('discover')
  .description('Run an LLM-driven discovery session and compile the result into a capability artifact.')
  .requiredOption('-g, --goal <text>', 'Natural-language goal.')
  .option('-t, --tenant <id>', 'Institution to record against.', 'northstar')
  .option(
    '-e, --entry <path>',
    "Entry path relative to the institution's base URL. Defaults to the entryPath " +
      'declared in institutions.json.',
  )
  .option('--headless', 'Run without a visible browser window.', false)
  .action(async (o: { goal: string; tenant: string; entry: string; headless: boolean }) => {
    requireAnthropicKey();

    const cfg = runtimeConfig({ headless: o.headless });
    const policy = loadPolicy();
    const redactor = buildRedactor(policy);
    const runId = newRunId('disc');
    const evidence = new EvidenceRecorder(runId, PATHS.evidence, redactor);
    const lease = new SessionLease(runId);

    let tenant;
    try {
      tenant = requireInstitution(o.tenant);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
    }
    const baseUrl = tenant.baseUrl;
    const entryUrl = `${baseUrl}${o.entry ?? tenant.entryPath ?? '/login'}`;

    banner('DISCOVERY', [
      ['goal', o.goal],
      ['tenant', `${tenant.displayName} (${tenant.tenantId})`],
      ['entry', entryUrl],
      ['model', `${cfg.model} @ effort=${cfg.effort}`],
      ['evidence', evidence.dir],
    ]);

    await startOperatorConsole().catch(() => undefined);

    const surface = await PlaywrightSurface.launch({
      lease,
      headless: cfg.headless,
      defaultTimeoutMs: policy.limits.defaultActionTimeoutMs,
      onObserve: observationRedactionHook(policy, redactor),
    });

    try {
      const trace = await runDiscovery(o.goal, entryUrl, tenant.tenantId, {
        surface,
        policy,
        redactor,
        evidence,
        model: cfg.model,
        effort: cfg.effort,
        ...(tenant.environmentNote ? { environmentNote: tenant.environmentNote } : {}),
      });

      evidence.saveJson('discovery-trace', trace);

      console.log(
        `\n  Discovery stopped: ${trace.stoppedBecause}  ` +
          `(${trace.actions.length} actions, ${trace.notes.length} notes, ${trace.llmCalls} model calls)`,
      );
      console.log(
        `  Tokens: ${trace.usage.inputTokens} in / ${trace.usage.outputTokens} out ` +
          `(${trace.usage.cacheReadTokens} read from cache)`,
      );

      if (!trace.finish) {
        console.error(
          `\n  No artifact written — the model did not call \`finish\`. See ${evidence.dir}/run.jsonl`,
        );
        process.exit(1);
      }

      const cap = compile(trace, {
        policy,
        tenantId: tenant.tenantId,
        tenantDisplayName: tenant.displayName,
        baseUrl,
        vendorProduct: tenant.product,
        vendorVersion: tenant.productVersion,
        model: cfg.model,
        effort: cfg.effort,
        discoveryRunId: runId,
      });

      const store = new CapabilityStore(PATHS.artifacts);
      // Never land on top of an existing recording of the same flow. A second
      // discovery is a candidate to diff against the approved one, not a
      // replacement for it.
      cap.version = store.nextVersion(cap.id);
      cap.provenance.contentHash = hashCapability(cap);
      const path = store.save(cap);

      console.log(`\n  Capability written: ${path}`);
      console.log(`    id           ${cap.id} v${cap.version}`);
      console.log(`    steps        ${cap.steps.length}`);
      console.log(`    inputs       ${cap.inputs.map((i) => `${i.name}:${i.type}`).join(', ') || '(none)'}`);
      console.log(`    outputs      ${cap.outputs.map((x) => `${x.name}:${x.type}`).join(', ') || '(none)'}`);
      console.log(`    outcomes     ${cap.outcomes.map((x) => `${x.code}(${x.classification})`).join(', ') || '(none)'}`);
      console.log(`    max risk     ${cap.policy.maxRisk}`);
      console.log(`    approval     ${cap.governance.approval}  <- draft until a human reviews it`);
      console.log(`    hash         ${cap.provenance.contentHash}`);
      console.log(`\n  Redaction: ${JSON.stringify(redactor.redactionStats.hits)}`);
    } finally {
      await surface.close();
    }
  });

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

program
  .command('replay')
  .description('Replay a saved capability deterministically. No model is called.')
  .requiredOption('-c, --capability <id>', 'Capability id.')
  .option('-v, --capability-version <n>', 'Pin a version.', (v) => Number(v))
  .option('-t, --tenant <id>', 'Institution to run against.')
  .option('-i, --input <k=v...>', 'Input parameter. Repeatable.', collect, [])
  .option('--confirm <id>', 'Confirmation token for state-committing capabilities.')
  .option('--unattended', 'Run as an agent would, with the stricter gates.', false)
  .option('--no-escalation', 'Fail instead of parking on a human.')
  .option('--headless', 'Run without a visible browser window.', false)
  .option('--repeat <n>', 'Run N times and report a stability figure.', (v) => Number(v), 1)
  .action(async (o: Record<string, unknown>) => {
    const cfg = runtimeConfig({ headless: Boolean(o['headless']) });
    const store = new CapabilityStore(PATHS.artifacts);
    const cap = store.load(String(o['capability']), o['capabilityVersion'] as number | undefined);
    const tenantId = String(o['tenant'] ?? cap.surface.recordedOnTenant);
    const tenant = cap.tenants.find((t) => t.tenantId === tenantId);

    if (!tenant) {
      console.error(
        `Capability "${cap.id}" has no binding for tenant "${tenantId}". Bound: ${cap.tenants.map((t) => t.tenantId).join(', ')}`,
      );
      process.exit(2);
    }

    const inputs = fillSecretsFromEnvironment(cap, parseInputs(o['input'] as string[]));
    const repeat = Math.max(1, Number(o['repeat'] ?? 1));
    const results: ReplayResult[] = [];

    for (let i = 0; i < repeat; i++) {
      const policy = loadPolicy();
      const redactor = buildRedactor(policy);
      const runId = newRunId('replay');
      const evidence = new EvidenceRecorder(runId, PATHS.evidence, redactor);
      const lease = new SessionLease(runId);

      if (i === 0) {
        banner('REPLAY', [
          ['capability', `${cap.id} v${cap.version}  (${cap.name})`],
          ['tenant', `${tenant.displayName} (${tenant.tenantId})`],
          ['mode', o['unattended'] ? 'unattended' : 'attended'],
          ['inputs', JSON.stringify(redactInputs(cap, inputs))],
          ['approval', cap.governance.approval],
          ['evidence', evidence.dir],
          ['model calls', '0 — the model is not in this loop'],
        ]);
      }

      await startOperatorConsole().catch(() => undefined);

      const surface = await PlaywrightSurface.launch({
        lease,
        headless: cfg.headless,
        defaultTimeoutMs: policy.limits.defaultActionTimeoutMs,
        onObserve: observationRedactionHook(policy, redactor),
      });

      let result: ReplayResult;
      try {
        await surface.act({ kind: 'navigate', url: detemplatize(cap.surface.entryUrl, tenant.baseUrl) });

        result = await replay({
          capability: cap,
          tenantId,
          inputs,
          surface,
          policy,
          redactor,
          evidence,
          lease,
          runId,
          mode: o['unattended'] ? 'unattended' : 'attended',
          confirmationToken: o['confirm'] as string | undefined,
          allowEscalation: o['escalation'] !== false,
          operatorBaseUrl: operatorBaseUrl(),
        });
      } finally {
        // Leave the session up when a human owns it.
        if (lease.holder !== 'operator') await surface.close();
      }

      evidence.saveJson('result', result);
      results.push(result);
      await store.recordRun(cap, result);

      console.log(`\n  ${repeat > 1 ? `[run ${i + 1}/${repeat}] ` : ''}${summarize(result)}`);
      printResult(result);
    }

    if (repeat > 1) {
      const ok = results.filter((r) => r.status === 'success' || r.status === 'outcome').length;
      console.log(`\n  Stability: ${ok}/${repeat} runs reached a terminal non-failure state.`);
    }

    process.exit(exitCodeFor(results[results.length - 1]!));
  });

// ---------------------------------------------------------------------------
// drift
// ---------------------------------------------------------------------------

program
  .command('drift')
  .description('Replay a capability and report how far the surface has moved from what it recorded.')
  .requiredOption('-c, --capability <id>', 'Capability id.')
  .option('-t, --tenant <id>', 'Institution to check against.')
  .option('-i, --input <k=v...>', 'Input parameter. Repeatable.', collect, [])
  .option('--headed', 'Show the browser.', false)
  .option('--json', 'Emit the report as JSON instead of a table.', false)
  .action(async (o: Record<string, unknown>) => {
    const cfg = runtimeConfig({ headless: !o['headed'] });
    const store = new CapabilityStore(PATHS.artifacts);
    const cap = store.load(String(o['capability']));
    const tenantId = String(o['tenant'] ?? cap.surface.recordedOnTenant);
    const tenant = cap.tenants.find((t) => t.tenantId === tenantId);

    if (!tenant) {
      console.error(
        `Capability "${cap.id}" has no binding for tenant "${tenantId}". Bound: ${cap.tenants.map((t) => t.tenantId).join(', ')}`,
      );
      process.exit(2);
    }

    const policy = loadPolicy();
    const redactor = buildRedactor(policy);
    const runId = newRunId('drift');
    const evidence = new EvidenceRecorder(runId, PATHS.evidence, redactor, false);
    const lease = new SessionLease(runId);
    const inputs = fillSecretsFromEnvironment(cap, parseInputs(o['input'] as string[]));

    const surface = await PlaywrightSurface.launch({
      lease,
      headless: cfg.headless,
      defaultTimeoutMs: policy.limits.defaultActionTimeoutMs,
      onObserve: observationRedactionHook(policy, redactor),
    });

    let result: ReplayResult;
    try {
      await surface.act({ kind: 'navigate', url: detemplatize(cap.surface.entryUrl, tenant.baseUrl) });
      result = await replay({
        capability: cap,
        tenantId,
        inputs,
        surface,
        policy,
        redactor,
        evidence,
        lease,
        runId,
        mode: 'attended',
        // A drift check is diagnostic. Parking it on a human would be a
        // category error: nobody asked for this run, so nobody is waiting to
        // take it over.
        allowEscalation: false,
      });
    } finally {
      await surface.close();
    }

    const report = analyzeRun(cap, result);
    evidence.saveJson('drift-report', report);

    if (o['json']) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderReport(report));
      console.log(`  Report: ${evidence.dir}/drift-report.json\n`);
    }

    // Exit codes so this can gate a scheduled job: 0 stable, 10 degraded,
    // 1 broken. Degraded is deliberately not a failure — it is a warning that
    // something needs a human before it becomes one.
    process.exit(report.status === 'stable' ? 0 : report.status === 'degraded' ? 10 : 1);
  });

// ---------------------------------------------------------------------------
// repair
// ---------------------------------------------------------------------------

program
  .command('repair')
  .description('Propose a reviewed patch for a drifted capability. Writes a draft; never applies it.')
  .requiredOption('-c, --capability <id>', 'Capability id.')
  .option('-t, --tenant <id>', 'Institution the drift was observed at.')
  .option('-i, --input <k=v...>', 'Input parameter for the diagnostic runs. Repeatable.', collect, [])
  .option('--rounds <n>', 'Diagnostic runs. Each one can reveal the next rename.', (v) => Number(v), 3)
  .option('--assist', 'Allow one bounded model call per finding the analysis cannot resolve.', false)
  .action(async (o: Record<string, unknown>) => {
    const cfg = runtimeConfig({ headless: true });
    const store = new CapabilityStore(PATHS.artifacts);
    const cap = store.load(String(o['capability']));
    const tenantId = String(o['tenant'] ?? cap.surface.recordedOnTenant);

    if (!cap.tenants.some((t) => t.tenantId === tenantId)) {
      console.error(`Capability "${cap.id}" has no binding for tenant "${tenantId}".`);
      process.exit(2);
    }

    const policy = loadPolicy();
    const redactor = buildRedactor(policy);
    const runId = newRunId('repair');
    const evidence = new EvidenceRecorder(runId, PATHS.evidence, redactor, false);
    const inputs = fillSecretsFromEnvironment(cap, parseInputs(o['input'] as string[]));

    const renames: ProposedRename[] = [];
    const refused: RepairProposal['refused'] = [];
    let modelCalls = 0;
    const rounds = Math.max(1, Number(o['rounds'] ?? 3));

    banner('REPAIR', [
      ['capability', `${cap.id} v${cap.version}`],
      ['tenant', tenantId],
      ['assist', o['assist'] ? `enabled (${cfg.model}, one call per unresolved finding)` : 'disabled — analysis only'],
      ['rounds', String(rounds)],
    ]);

    /**
     * Each diagnostic run stops at the FIRST unresolved step, so one run can
     * only ever reveal one rename. Re-running with the overlay applied is what
     * uncovers the next one — an 8.7 upgrade that re-words four fields needs
     * four rounds to describe itself fully. Bounded, because a capability that
     * needs ten rounds is not drifting, it has been replaced.
     */
    for (let round = 1; round <= rounds; round++) {
      // Probe with the overlay accumulated so far, without writing anything.
      const probe: Capability = JSON.parse(JSON.stringify(cap));
      const binding = probe.tenants.find((t) => t.tenantId === tenantId)!;
      for (const r of renames) binding.labelOverrides[r.from] = r.to;

      const report = await diagnose(probe, tenantId, inputs, policy, redactor, evidence, cfg.headless);
      console.log(`  round ${round}: ${report.status}${report.findings.length ? ` — ${report.findings.length} finding(s)` : ''}`);

      if (report.status === 'stable') break;

      const before = renames.length;

      for (const rename of report.suggestedLabelOverrides) {
        if (renames.some((r) => r.from === rename.from)) continue;
        renames.push({ ...rename, source: 'analysis', reason: `observed on ${rename.occurrences} step(s)` });
      }

      for (const f of report.findings) {
        if (isRepairable(f)) continue;
        if (refused.some((r) => r.stepId === f.stepId && r.kind === f.kind)) continue;

        if (o['assist'] && (f.kind === 'ambiguous' || f.kind === 'missing')) {
          requireAnthropicKey();
          const { rename, calls } = await assistRename(f, {
            model: cfg.model,
            candidatesFor: () => lastCandidates,
            declaredFor: () => declaredTargetFor(probe, f.stepId),
          });
          modelCalls += calls;
          if (rename) {
            renames.push(rename);
            console.log(`           assisted: "${rename.from}" -> "${rename.to}" (${rename.reason})`);
            continue;
          }
        }
        refused.push({ stepId: f.stepId, kind: f.kind, why: refusalFor(f) });
      }

      if (renames.length === before) break; // no progress; further rounds cost time for nothing
    }

    const proposal: RepairProposal = {
      capabilityId: cap.id,
      tenantId,
      fromVersion: cap.version,
      renames,
      refused,
      modelCalls,
    };

    if (!renames.length) {
      console.log(renderProposal(proposal, undefined, []));
      evidence.saveJson('repair-proposal', proposal);
      process.exit(refused.length ? 1 : 0);
    }

    const patch = applyRenames(cap, tenantId, renames, {
      nextVersion: store.nextVersion(cap.id),
      runId,
      model: modelCalls ? cfg.model : null,
    });

    if (patch.ok && patch.capability) store.save(patch.capability);
    console.log(renderProposal(proposal, patch.capability, patch.problems));
    evidence.saveJson('repair-proposal', { ...proposal, problems: patch.problems });

    process.exit(patch.ok ? 0 : 1);
  });

/** Candidates from the most recent diagnostic failure, for the assist path. */
let lastCandidates: Array<{ description: string; score: number; role?: string; label?: string }> = [];

function declaredTargetFor(cap: Capability, stepId: string) {
  const step = cap.steps.find((s) => s.id === stepId);
  if (!step || !('target' in step.act)) return undefined;
  const t = step.act.target;
  return { role: t.role, label: t.label, container: t.container, description: t.description };
}

/** One diagnostic replay, analysed. No writes, no escalation, no model. */
async function diagnose(
  cap: Capability,
  tenantId: string,
  inputs: Record<string, string>,
  policy: ReturnType<typeof loadPolicy>,
  redactor: ReturnType<typeof buildRedactor>,
  evidence: EvidenceRecorder,
  headless: boolean,
): Promise<DriftReport> {
  const tenant = cap.tenants.find((t) => t.tenantId === tenantId)!;
  const lease = new SessionLease(`diagnose-${tenantId}`);
  const surface = await PlaywrightSurface.launch({
    lease,
    headless,
    defaultTimeoutMs: policy.limits.defaultActionTimeoutMs,
    onObserve: observationRedactionHook(policy, redactor),
  });

  let result: ReplayResult;
  try {
    await surface.act({ kind: 'navigate', url: detemplatize(cap.surface.entryUrl, tenant.baseUrl) });
    result = await replay({
      capability: cap,
      tenantId,
      inputs,
      surface,
      policy,
      redactor,
      evidence,
      lease,
      runId: `diagnose-${tenantId}`,
      mode: 'attended',
      allowEscalation: false,
    });
  } finally {
    await surface.close();
  }

  lastCandidates = result.status === 'failure' ? (result.failure.candidates ?? []) : [];
  return analyzeRun(cap, result);
}

// ---------------------------------------------------------------------------
// capabilities / operator / catalog
// ---------------------------------------------------------------------------

program
  .command('capabilities')
  .description('List saved capabilities as agent-facing tool definitions.')
  .option('--json', 'Emit the raw tool definitions.', false)
  .action((o: { json: boolean }) => {
    const store = new CapabilityStore(PATHS.artifacts);
    const caps = store.listLatest();

    if (o.json) {
      console.log(JSON.stringify(caps.map(toToolDefinition), null, 2));
      return;
    }

    if (store.rejected.length) {
      console.log(`\n  ${store.rejected.length} artifact(s) on disk failed validation and are NOT offered:\n`);
      for (const r of store.rejected) console.log(`  ${r.file}\n    ${r.reason.replace(/\n/g, '\n    ')}\n`);
    }

    if (!caps.length) {
      console.log(
        store.rejected.length
          ? 'No valid capabilities. Fix or re-record the artifacts listed above.'
          : 'No capabilities yet. Run `npm run discover -- --goal "..."` first.',
      );
      return;
    }

    console.log(`\n  ${caps.length} capability(ies):\n`);
    for (const c of caps) {
      const s = c.governance.stability;
      console.log(`  ${c.id} v${c.version}  —  ${c.name}`);
      console.log(`      ${c.description.split('\n')[0]}`);
      console.log(
        `      inputs: ${c.inputs.map((i) => `${i.name}:${i.type}`).join(', ') || '—'}` +
          `   outputs: ${c.outputs.map((x) => `${x.name}:${x.type}`).join(', ') || '—'}`,
      );
      console.log(
        `      risk: ${c.policy.maxRisk}   approval: ${c.governance.approval}` +
          `   tenants: ${c.tenants.map((t) => t.tenantId).join(', ')}` +
          `   stability: ${s.successes}/${s.runs}`,
      );
      const business = c.outcomes.filter((x) => x.classification === 'business');
      if (business.length) {
        console.log(`      business outcomes: ${business.map((x) => x.code).join(', ')}`);
      }
      console.log('');
    }
  });

program
  .command('operator')
  .description('Start the human-in-the-loop operator console.')
  .action(async () => {
    const url = await startOperatorConsole();
    console.log(`\n  Operator console: ${url}\n  Ctrl-C to stop.\n`);
  });

program
  .command('catalog')
  .description('Start the agent-facing capability API.')
  .action(async () => {
    await startCatalog();
  });

/**
 * Bind a capability recorded at one institution to another running the same
 * vendor product. This is the cross-tenant reuse path: a label overlay and any
 * extra guards, rather than a re-recording.
 */
program
  .command('bind-tenant')
  .description('Bind an existing capability to another institution running the same product.')
  .requiredOption('-c, --capability <id>', 'Capability id.')
  .requiredOption('-t, --tenant <id>', 'Tenant to add.')
  .option('--label <canonical=tenant...>', 'Label override. Repeatable.', collect, [])
  .option(
    '--dismiss <detectText=buttonLabel...>',
    'Interstitial this tenant interposes: when the text appears, click the named button. Repeatable.',
    collect,
    [],
  )
  .action((o: Record<string, unknown>) => {
    const store = new CapabilityStore(PATHS.artifacts);
    const cap = store.load(String(o['capability']));
    const tenantId = String(o['tenant']);
    let tenant;
    try {
      tenant = requireInstitution(tenantId);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
    }

    const overrides: Record<string, string> = {};
    for (const pair of (o['label'] as string[]) ?? []) {
      const idx = pair.indexOf('=');
      if (idx > 0) overrides[pair.slice(0, idx)] = pair.slice(idx + 1);
    }

    /**
     * Guards this tenant needs that the recording tenant did not.
     *
     * This is the second half of the per-tenant delta, and in practice the
     * more interesting half: two institutions on the same vendor build differ
     * by vocabulary *and* by the screens their configuration interposes.
     * Lakeshore shows a daily maintenance notice after sign-in; Northstar does
     * not. Declaring it here as a `recoverable` outcome is what lets one
     * recording serve both, instead of a second discovery run.
     */
    const additionalOutcomes = ((o['dismiss'] as string[]) ?? []).map((pair, i) => {
      const idx = pair.indexOf('=');
      const detectText = idx > 0 ? pair.slice(0, idx) : pair;
      const buttonLabel = idx > 0 ? pair.slice(idx + 1) : 'Continue';
      return {
        code: `tenant_interstitial_${i + 1}`,
        title: `${tenant.displayName} interstitial: "${detectText}"`,
        classification: 'recoverable' as const,
        detect: { kind: 'textPresent' as const, text: detectText, caseSensitive: false },
        scope: 'global' as const,
        recovery: {
          do: 'click' as const,
          target: {
            description: `button "${buttonLabel}" dismissing this tenant's interstitial`,
            role: 'button' as const,
            name: buttonLabel,
            nameMatch: 'normalized' as const,
            labelMatch: 'normalized' as const,
            framePath: [] as string[],
            hints: {},
          },
        },
        extract: [],
        origin: 'reviewer' as const,
        addedBy: 'bind-tenant',
      };
    });

    const existing = cap.tenants.findIndex((t) => t.tenantId === tenantId);
    const binding = {
      tenantId,
      displayName: tenant.displayName,
      baseUrl: tenant.baseUrl,
      productVersion: tenant.productVersion,
      labelOverrides: overrides,
      additionalOutcomes,
      overrides: {},
      verification: { lastResult: 'unverified' as const },
    };

    if (existing >= 0) cap.tenants[existing] = { ...cap.tenants[existing]!, ...binding };
    else cap.tenants.push(binding);

    cap.version += 1;
    cap.governance.approval = 'draft'; // a new binding is a new thing to review
    // Re-hash: this is a *tracked* edit. The hash exists to reveal untracked
    // ones, and the version bump plus the approval reset are the audit trail.
    // Leaving it stale would cry wolf on every subsequent load.
    cap.provenance.contentHash = hashCapability(cap);
    const path = store.save(cap);
    console.log(`  Bound ${cap.id} to ${tenantId} -> ${path} (now v${cap.version}, approval reset to draft)`);
    console.log(`  Label overrides: ${JSON.stringify(overrides)}`);
    if (additionalOutcomes.length) {
      console.log(`  Tenant guards:   ${additionalOutcomes.map((g) => g.title).join('; ')}`);
    }
  });

/**
 * Reviewer-added outcome rule.
 *
 * `verify-outcomes` reports which declared detectors actually fire and, by
 * omission, which real states nothing covers — a restricted record surfacing
 * as `checkpoint_failed` is the system telling you it does not know about that
 * screen. Closing that gap is a review action, and it resets approval so the
 * addition gets read by a person before it can run unattended.
 */
program
  .command('declare-outcome')
  .description('Add an outcome rule the discovery model missed. Records reviewer provenance.')
  .requiredOption('-c, --capability <id>', 'Capability id.')
  .requiredOption('--code <name>', 'snake_case machine name the caller switches on.')
  .requiredOption('--title <text>', 'Human-readable title.')
  .requiredOption(
    '--class <classification>',
    'business | recoverable | hard | escalate',
  )
  .option('--detect <text>', 'Text that appears on that screen and nowhere earlier.')
  .option(
    '--detect-regex <pattern>',
    'Regex alternative to --detect, compiled case-insensitively with dot-matches-newline. ' +
      'Needed for rules about what is ABSENT from a section, e.g. a Share Accounts grid with no SAVINGS row.',
  )
  .requiredOption('-r, --reviewer <name>', 'Who is asserting this rule.')
  .option('--dismiss <buttonLabel>', 'For `recoverable`: the button that clears the state.')
  .option('--guidance <text>', 'For `escalate`: what the operator should do.')
  .action((o: Record<string, unknown>) => {
    const store = new CapabilityStore(PATHS.artifacts);
    const cap = store.loadForEdit(String(o['capability']));
    const classification = String(o['class']) as 'business' | 'recoverable' | 'hard' | 'escalate';

    if (!['business', 'recoverable', 'hard', 'escalate'].includes(classification)) {
      console.error(`Unknown classification "${classification}".`);
      process.exit(2);
    }

    const literal = o['detect'] === undefined ? undefined : String(o['detect']);
    const pattern = o['detectRegex'] === undefined ? undefined : String(o['detectRegex']);

    if ((literal === undefined) === (pattern === undefined)) {
      console.error('Give exactly one of --detect or --detect-regex.');
      process.exit(2);
    }

    // Compile it here rather than letting a broken pattern reach the artifact.
    // `validateCapability` would catch it on save, but the error is far more
    // useful pointing at the flag the reviewer just typed.
    if (pattern !== undefined) {
      try {
        new RegExp(pattern, 'is');
      } catch (e) {
        console.error(`--detect-regex does not compile: ${(e as Error).message}`);
        process.exit(2);
      }
    }

    const detect =
      pattern !== undefined
        ? ({ kind: 'regexPresent', pattern } as const)
        : ({ kind: 'textPresent', text: literal as string, caseSensitive: false } as const);

    const rule = {
      code: String(o['code']).toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      title: String(o['title']),
      classification,
      detect,
      scope: 'global' as const,
      extract: [],
      origin: 'reviewer' as const,
      addedBy: String(o['reviewer']),
      ...(classification === 'recoverable'
        ? {
            recovery: {
              do: 'click' as const,
              target: {
                description: `button "${String(o['dismiss'] ?? 'Continue')}" clearing this state`,
                role: 'button' as const,
                name: String(o['dismiss'] ?? 'Continue'),
                nameMatch: 'normalized' as const,
                labelMatch: 'normalized' as const,
                framePath: [] as string[],
                hints: {},
              },
            },
          }
        : {}),
      ...(classification === 'escalate'
        ? { operatorGuidance: String(o['guidance'] ?? 'Resolve this manually, then hand control back.') }
        : {}),
    };

    if (cap.outcomes.some((x) => x.code === rule.code)) {
      console.error(`Capability already declares an outcome "${rule.code}".`);
      process.exit(2);
    }

    cap.outcomes.push(rule);
    cap.version += 1;
    cap.governance.approval = 'draft';
    cap.provenance.contentHash = hashCapability(cap);
    store.save(cap);

    console.log(
      `  Added ${rule.code} (${classification}, origin=reviewer) to ${cap.id}. Now v${cap.version}, approval reset to draft.`,
    );
  });

/**
 * Strengthen a step's checkpoint before approval.
 *
 * The discovery model writes checkpoints that prove the flow MOVED - a URL
 * changed, a heading appeared. What it consistently does not write is a
 * checkpoint that proves the flow moved *with the caller's values*, because
 * until conditions could reference parameters there was no way to say it.
 *
 * On a two-phase commit that distinction is the whole point. "Reached the
 * review screen" and "the review screen restates the amount and the accounts
 * this invocation was given" are different assertions, and only the second one
 * makes review-then-post worth more than clicking two buttons.
 *
 * This is the same reviewer workflow `declare-outcome` provides: a human
 * closing a gap the model left, recorded as such, resetting approval to draft
 * so nothing is strengthened behind a reviewer's back.
 */
program
  .command('assert-checkpoint')
  .description("Add an assertion to a step's checkpoint. Use {{param}} to reference a typed input.")
  .requiredOption('-c, --capability <id>', 'Capability id.')
  .requiredOption('-s, --step <id>', 'Step whose checkpoint to strengthen.')
  .option('--text <text...>', 'Text that must be present. Repeatable. Supports {{param}}.', collect, [])
  .option(
    '--replace',
    'Discard the recorded checkpoint instead of adding to it. For when the recorded ' +
      'assertion is wrong, not merely weak.',
    false,
  )
  .requiredOption('--why <text>', 'Why a reviewer added this. Recorded in governance notes.')
  .action((o: Record<string, unknown>) => {
    const store = new CapabilityStore(PATHS.artifacts);
    const cap = store.loadForEdit(String(o['capability']));
    const stepId = String(o['step']);
    const step = cap.steps.find((x) => x.id === stepId);
    if (!step) {
      console.error(`No step "${stepId}" in ${cap.id}. Steps: ${cap.steps.map((x) => x.id).join(', ')}`);
      process.exit(2);
      return;
    }

    const texts = (o['text'] as string[]) ?? [];
    if (!texts.length) {
      console.error('Nothing to assert. Pass at least one --text.');
      process.exit(2);
      return;
    }

    // Every {{param}} must name a declared input, or the assertion is dead on
    // arrival: `fill` leaves an unknown reference alone, so the checkpoint
    // would look for the literal text "{{amont}}" and fail every run.
    const declared = new Set(cap.inputs.map((i) => i.name));
    for (const t of texts) {
      for (const m of t.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g)) {
        const name = m[1]!;
        if (!declared.has(name)) {
          console.error(
            `"{{${name}}}" is not an input of ${cap.id}. Inputs: ${[...declared].join(', ')}`,
          );
          process.exit(2);
          return;
        }
        if (cap.inputs.find((i) => i.name === name)?.sensitivity === 'secret') {
          console.error(
            `"{{${name}}}" is a secret input. A checkpoint prints what it expected when it fails, ` +
              `so asserting on a secret would put it in a log. Refusing.`,
          );
          process.exit(2);
          return;
        }
      }
    }

    const added = texts.map((t) => ({ kind: 'textPresent' as const, text: t, caseSensitive: false }));

    /**
     * `--replace` exists for a checkpoint that is wrong rather than weak, and
     * the distinction matters: weakening an assertion to make a run pass is
     * exactly what this system is not allowed to do.
     *
     * The case it was built for: a capability recorded as a supervisor asserted
     * `Signed on as S.` after its sign-on step. That checks WHO signed on, not
     * THAT anyone did — it is not what the step guarantees and not part of the
     * capability's contract, and it silently made the artifact unusable by any
     * other operator. Replacing it with "reached the main menu, signed on" is a
     * correction; ANDing a second assertion onto a wrong one would not be.
     */
    const existing = o['replace'] ? undefined : step.checkpoint;
    step.checkpoint = existing
      ? { kind: 'all' as const, of: [existing, ...added] }
      : added.length === 1
        ? added[0]!
        : { kind: 'all' as const, of: added };

    const note = `[reviewer] checkpoint on ${stepId}: ${String(o['why'])}`;
    cap.governance.notes = cap.governance.notes ? `${cap.governance.notes}
${note}` : note;
    cap.version += 1;
    cap.governance.approval = 'draft';
    cap.provenance.contentHash = hashCapability(cap);
    store.save(cap);

    console.log(
      `  ${o['replace'] ? 'Replaced' : 'Strengthened'} the checkpoint on ${stepId} of ${cap.id}: ` +
        `${texts.length} assertion(s).`,
    );
    for (const t of texts) console.log(`    must show: ${t}`);
    console.log(`  Now v${cap.version}, approval reset to draft.`);
  });

/**
 * Change an outcome's classification, with a reason.
 *
 * Discovery classifies each outcome from what one capability saw, so the same
 * event lands differently across a set: a rejected sign-on came back `hard` in
 * three capabilities, `escalate` in two and `business` in one. Each is
 * arguable in isolation; together they are incoherent, and a caller switching
 * on the result shape cannot be asked to guess.
 *
 * The classification is a product decision about what the caller should DO,
 * which makes it a reviewer's call rather than the model's. Recorded as such,
 * with the reason, and approval resets to draft.
 */
program
  .command('reclassify-outcome')
  .description("Change an outcome's classification. Records reviewer provenance and the reason.")
  .requiredOption('-c, --capability <id>', 'Capability id.')
  .requiredOption('--code <name>', 'Outcome code to reclassify.')
  .requiredOption('--to <classification>', 'business | recoverable | hard | escalate')
  .requiredOption('--why <text>', 'Why. Recorded in governance notes.')
  .option('--guidance <text>', 'Operator guidance, required when moving to escalate.')
  .action((o: Record<string, unknown>) => {
    const store = new CapabilityStore(PATHS.artifacts);
    const cap = store.loadForEdit(String(o['capability']));
    const code = String(o['code']);
    const rule = cap.outcomes.find((x) => x.code === code);
    if (!rule) {
      console.error(`No outcome "${code}" in ${cap.id}. Declared: ${cap.outcomes.map((x) => x.code).join(', ')}`);
      process.exit(2);
      return;
    }

    const to = String(o['to']);
    if (!['business', 'recoverable', 'hard', 'escalate'].includes(to)) {
      console.error(`Unknown classification "${to}".`);
      process.exit(2);
      return;
    }
    if (to === 'recoverable' && !rule.recovery) {
      // A recoverable outcome with no recovery is a run that loops until its
      // budget runs out and then reports the wrong reason.
      console.error(`"${code}" has no recovery action, so it cannot be recoverable. Declare one first.`);
      process.exit(2);
      return;
    }

    const from = rule.classification;
    rule.classification = to as typeof rule.classification;

    // An explicit --guidance always wins. This is the text an on-call human
    // reads first, and it is the most likely thing to go stale: the model
    // writes it from what it inferred during discovery, and a later decision
    // can quietly invalidate the advice without touching the classification.
    if (typeof o['guidance'] === 'string') rule.operatorGuidance = o['guidance'];

    // Only a `recoverable` outcome ever applies a recovery. Leaving one
    // attached to any other classification is dead weight, and the validator
    // rejects it outright - so the artifact would be written and then silently
    // fail to load, leaving the previous version running.
    let droppedRecovery = false;
    if (to !== 'recoverable' && rule.recovery) {
      delete rule.recovery;
      droppedRecovery = true;
    }
    if (to === 'escalate' && !rule.operatorGuidance) {
      rule.operatorGuidance = String(o['guidance'] ?? 'Resolve this manually, then hand control back.');
    }

    const note = `[reviewer] ${code}: ${from} -> ${to}. ${String(o['why'])}`;
    cap.governance.notes = cap.governance.notes ? `${cap.governance.notes}
${note}` : note;
    cap.version += 1;
    cap.governance.approval = 'draft';
    cap.provenance.contentHash = hashCapability(cap);
    store.save(cap);

    if (droppedRecovery) {
      console.log(`  Dropped ${code}'s recovery action: only a recoverable outcome applies one.`);
    }
    console.log(`  ${cap.id}: ${code} ${from} -> ${to}. Now v${cap.version}, approval reset to draft.`);
  });

/**
 * Correct an input's description or example.
 *
 * These two fields are not decoration: they are the entire contract a calling
 * agent has for what to put in a field. Discovery fills them from what it
 * happened to type, and on a combobox that means the full visible option text
 * — "100234-S0001-19 - Regular Shares ($99.00)" — which embeds a balance that
 * changes between runs. Replay works either way because the surface matches an
 * option by value before label, but a router reading that example asks the
 * user for dropdown text instead of a share id.
 *
 * A reviewer fixing the contract is cheaper and more honest than re-recording
 * an artifact to get better prose out of the model.
 */
program
  .command('revise-input')
  .description("Correct an input's description or example. Records reviewer provenance.")
  .requiredOption('-c, --capability <id>', 'Capability id.')
  .requiredOption('--input <name>', 'Input parameter name.')
  .option('--description <text>', 'Replacement description.')
  .option('--example <text>', 'Replacement example value.')
  .requiredOption('--why <text>', 'Why. Recorded in governance notes.')
  .action((o: Record<string, unknown>) => {
    const store = new CapabilityStore(PATHS.artifacts);
    const cap = store.loadForEdit(String(o['capability']));
    const name = String(o['input']);
    const input = cap.inputs.find((i) => i.name === name);
    if (!input) {
      console.error(`No input "${name}" on ${cap.id}. Inputs: ${cap.inputs.map((i) => i.name).join(', ')}`);
      process.exit(2);
      return;
    }
    if (o['description'] === undefined && o['example'] === undefined) {
      console.error('Nothing to change. Pass --description and/or --example.');
      process.exit(2);
      return;
    }
    if (input.sensitivity === 'secret' && o['example'] !== undefined) {
      // An example is written into the artifact, which is committed.
      console.error(`"${name}" is a secret input; it must not carry an example value.`);
      process.exit(2);
      return;
    }

    const before = { description: input.description, example: input.example };
    if (o['description'] !== undefined) input.description = String(o['description']);
    if (o['example'] !== undefined) input.example = String(o['example']);

    const note = `[reviewer] input ${name}: ${String(o['why'])}`;
    cap.governance.notes = cap.governance.notes ? `${cap.governance.notes}
${note}` : note;
    cap.version += 1;
    cap.governance.approval = 'draft';
    cap.provenance.contentHash = hashCapability(cap);
    store.save(cap);

    console.log(`  ${cap.id}: revised input "${name}".`);
    if (before.example !== input.example) console.log(`    example: ${before.example} -> ${input.example}`);
    console.log(`  Now v${cap.version}, approval reset to draft.`);
  });

program
  .command('approve')
  .description('Mark a capability approved for unattended execution.')
  .requiredOption('-c, --capability <id>', 'Capability id.')
  .requiredOption('-r, --reviewer <name>', 'Who reviewed it.')
  .option('-n, --note <text>', 'Review note.')
  .option('-v, --capability-version <n>', 'Approve a specific version.', (v) => Number(v))
  .option(
    '--force',
    'Approve despite too few clean runs. Recorded in the artifact, not hidden.',
    false,
  )
  .action((o: Record<string, unknown>) => {
    const store = new CapabilityStore(PATHS.artifacts);
    const cap = store.load(String(o['capability']), o['capabilityVersion'] as number | undefined);
    const policy = loadPolicy();

    /**
     * Approval is the gate between "a model wrote this" and "this runs
     * unattended against member accounts". Requiring evidence that the thing
     * has actually completed, more than once, makes that gate cost something.
     *
     * The override exists and is *recorded* rather than silent: there are real
     * reasons to approve early — a capability whose only failure mode needs
     * production data, say — and a governance control people route around is
     * worse than one that bends and leaves a mark. What is not available is
     * approving with no clean run at all and no trace of having decided to.
     */
    const need = policy.limits.minStableRunsBeforeApproval;
    const { runs, successes } = cap.governance.stability;

    if (successes < need) {
      if (!o['force']) {
        console.error(
          `\n  Refusing to approve ${cap.id} v${cap.version}: ${successes} clean run(s) of ${runs}, ` +
            `and policy requires ${need}.\n\n` +
            `  Replay it a few times first:\n` +
            `    npm run replay -- -c ${cap.id} --repeat ${need - successes} -i ...\n\n` +
            `  Or approve deliberately, which is recorded in the artifact:\n` +
            `    npx tsx src/cli.ts approve -c ${cap.id} -r <you> --force -n "<why>"\n`,
        );
        process.exit(2);
      }
      cap.governance.notes =
        `${o['note'] ? `${String(o['note'])} ` : ''}` +
        `[force-approved with ${successes}/${need} clean runs by ${String(o['reviewer'])}]`;
    }

    cap.governance.approval = 'approved';
    cap.governance.reviewedBy = String(o['reviewer']);
    if (o['note'] && successes >= need) cap.governance.notes = String(o['note']);
    // Tracked edit: re-hash so the mismatch warning stays meaningful.
    cap.provenance.contentHash = hashCapability(cap);
    store.save(cap);
    console.log(`  ${cap.id} v${cap.version} approved by ${cap.governance.reviewedBy}.`);
  });

/** Emit a runnable Playwright spec from an artifact — the code-gen stretch goal. */
program
  .command('codegen')
  .description('Emit a human-readable review document for a capability.')
  .requiredOption('-c, --capability <id>', 'Capability id.')
  .action((o: Record<string, unknown>) => {
    const store = new CapabilityStore(PATHS.artifacts);
    const cap = store.load(String(o['capability']));
    const md = renderReview(cap);
    const path = join(PATHS.artifacts, `${cap.id}.v${cap.version}.review.md`);
    writeFileSync(path, md, 'utf8');
    console.log(md);
    console.log(`\n  Written to ${path}`);
  });

program.parseAsync(process.argv).catch((e: Error) => {
  console.error(`\n  ${e.message}\n`);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseInputs(pairs: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}


/** Never print a secret input back to the terminal. */
function redactInputs(
  cap: { inputs: Array<{ name: string; sensitivity: string }> },
  inputs: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputs)) {
    const decl = cap.inputs.find((p) => p.name === k);
    out[k] = decl && (decl.sensitivity === 'secret' || decl.sensitivity === 'pii') ? '[REDACTED]' : v;
  }
  return out;
}

function banner(title: string, rows: Array<[string, string]>): void {
  console.log(`\n  ${'─'.repeat(72)}`);
  console.log(`  ${title}`);
  console.log(`  ${'─'.repeat(72)}`);
  for (const [k, v] of rows) console.log(`  ${k.padEnd(13)} ${v}`);
  console.log(`  ${'─'.repeat(72)}\n`);
}

function printResult(r: ReplayResult): void {
  switch (r.status) {
    case 'success':
      for (const [k, v] of Object.entries(r.outputs)) {
        // `redacted` means "scrubbed from the persisted evidence", not
        // "withheld from you" — the caller is authorised, the log file is not.
        const note = v.redacted ? `  (${v.sensitivity}; scrubbed from evidence)` : '';
        console.log(`      ${k.padEnd(20)} ${String(v.value)}${note}`);
      }
      break;
    case 'outcome':
      console.log(`      This is a valid answer, not a failure. Exit code 0.`);
      for (const [k, v] of Object.entries(r.details)) console.log(`      ${k.padEnd(20)} ${String(v.value)}`);
      break;
    case 'escalated':
      console.log(`      ${r.guidance}`);
      console.log(`      Operator: ${r.operatorUrl}`);
      break;
    case 'failure':
      console.log(`      step        ${r.failure.atStepId ?? '(pre-flight)'}  ${r.failure.stepIntent ?? ''}`);
      if (r.failure.expected) console.log(`      expected    ${r.failure.expected}`);
      if (r.failure.observed) console.log(`      observed    ${r.failure.observed}`);
      if (r.failure.remediation) console.log(`      fix         ${r.failure.remediation}`);
      if (r.failure.candidates?.length) {
        console.log(`      candidates:`);
        for (const c of r.failure.candidates) console.log(`        ${String(c.score).padStart(4)}  ${c.description}`);
      }
      console.log(`      evidence    ${r.meta.evidenceDir}`);
      break;
  }
}

function renderReview(cap: import('./types/artifact.js').Capability): string {
  const lines: string[] = [];
  lines.push(`# ${cap.name}  \`${cap.id}\` v${cap.version}`);
  lines.push('');
  lines.push(cap.description);
  lines.push('');
  lines.push(`**Product:** ${cap.surface.product} ${cap.surface.productVersion ?? ''} · **Recorded on:** ${cap.surface.recordedOnTenant} · **Risk:** ${cap.policy.maxRisk} · **Approval:** ${cap.governance.approval}`);
  lines.push('');
  lines.push('## Inputs');
  lines.push('| name | type | sensitivity | required | description |');
  lines.push('|---|---|---|---|---|');
  for (const i of cap.inputs) {
    lines.push(`| \`${i.name}\` | ${i.type} | ${i.sensitivity} | ${i.required ? 'yes' : 'no'} | ${i.description} |`);
  }
  lines.push('');
  lines.push('## Outputs');
  lines.push('| name | type | sensitivity | how it is read |');
  lines.push('|---|---|---|---|');
  for (const o of cap.outputs) {
    const ex = o.extraction;
    const how =
      ex.via === 'fromTableCell'
        ? `row "${ex.rowMatch}" × column "${ex.columnLabel}"`
        : ex.via === 'fromLabelledCell'
          ? `cell labelled "${ex.label}"`
          : ex.via;
    lines.push(`| \`${o.name}\` | ${o.type} | ${o.sensitivity} | ${how} |`);
  }
  lines.push('');
  lines.push('## Steps');
  for (const s of cap.steps) {
    const target =
      'target' in s.act ? ` → ${s.act.target.description}` : 'url' in s.act ? ` → ${s.act.url}` : '';
    lines.push(`- **${s.id}** *(${s.risk})* ${s.intent}`);
    lines.push(`  - action: \`${s.act.action}\`${target}`);
    lines.push(`  - checkpoint: ${s.checkpoint ? describeCond(s.checkpoint) : '**none**'}`);
  }
  lines.push('');
  lines.push('## Outcomes');
  for (const o of cap.outcomes) {
    lines.push(`- \`${o.code}\` — **${o.classification}** — ${o.title}`);
  }
  lines.push('');
  lines.push(`## Success checkpoint`);
  lines.push(describeCond(cap.successCheckpoint));
  lines.push('');
  lines.push(`_Content hash \`${cap.provenance.contentHash}\` · discovered by ${cap.provenance.model} on ${cap.provenance.discoveredAt}._`);
  return lines.join('\n');
}

function describeCond(c: import('./types/artifact.js').Condition): string {
  switch (c.kind) {
    case 'urlMatches':
      return `URL matches \`${c.pattern}\``;
    case 'textPresent':
      return `text "${c.text}" is on screen`;
    case 'textAbsent':
      return `text "${c.text}" is absent`;
    case 'regexPresent':
      return `page text matches \`${c.pattern}\``;
    case 'elementPresent':
      return `element present: ${c.target.description}`;
    case 'elementAbsent':
      return `element absent: ${c.target.description}`;
    case 'httpStatusAtLeast':
      return `HTTP status >= ${c.status}`;
    case 'all':
      return c.of.map(describeCond).join(' **and** ');
    case 'any':
      return c.of.map(describeCond).join(' **or** ');
    case 'not':
      return `not (${describeCond(c.of)})`;
  }
}
