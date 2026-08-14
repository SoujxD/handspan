/**
 * Deterministic replay — the path an AI agent triggers in production.
 *
 * No model is constructed, imported, or called anywhere below this line. The
 * result's `meta.llmCalls` is asserted to be 0 before it is returned, so that
 * claim is checked rather than promised.
 *
 * The execution order per step is fixed and is where the error taxonomy lives:
 *
 *   1. Snapshot.
 *   2. Evaluate GLOBAL outcome rules against it. A `recoverable` rule fires its
 *      recovery and we retry the same step; a `business` rule ends the run as a
 *      successful outcome; `escalate` hands off to a human; `hard` stops.
 *      Guards run *before* the step, every step, which is how a surprise
 *      interstitial or a session expiry is caught wherever it appears rather
 *      than only where it was first seen.
 *   3. Re-derive risk from policy and compare with the recorded risk. A
 *      mismatch means the policy tightened or the artifact was edited — both
 *      warrant stopping.
 *   4. Resolve the target deterministically. Not found or ambiguous -> stop.
 *   5. Act.
 *   6. Verify the checkpoint. This is what makes "the click worked" a fact
 *      rather than an assumption.
 *
 * Retries are deliberately narrow. Only `safe` idempotent steps carry an
 * attempt budget; the schema forbids retrying anything that might have already
 * committed, because a double-posted transaction is unrecoverable in a way a
 * failed run is not.
 */

import type {
  Capability,
  Condition,
  InputParam,
  OutcomeRule,
  Step,
  TenantBinding,
  ValueSource,
} from '../types/artifact.js';
import type {
  EvidenceRef,
  ReplayResult,
  RunMeta,
  TraceEntry,
  TypedValue,
} from '../types/result.js';
import type { Surface, SurfaceSnapshot } from '../types/surface.js';
import type { PolicyEngine } from '../safety/policy.js';
import type { Redactor } from '../safety/redaction.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';
import { resolve, type ResolveOptions } from '../surface/web/resolver.js';
import { describeCondition, evaluateCondition, explainFailure, extract } from './evaluate.js';
import { detemplatize } from '../agent/compiler.js';
import { broker } from '../control/escalation.js';
import type { SessionLease } from '../control/lease.js';

export interface ReplayOptions {
  capability: Capability;
  tenantId: string;
  inputs: Record<string, string>;
  surface: Surface;
  policy: PolicyEngine;
  redactor: Redactor;
  evidence: EvidenceRecorder;
  lease: SessionLease;
  runId: string;
  mode: 'attended' | 'unattended';
  confirmationToken?: string;
  /** Set false in tests to keep failures from parking on a human. */
  allowEscalation?: boolean;
  /** How long a run waits for an operator before giving up. */
  escalationWaitMs?: number;
  operatorBaseUrl?: string;
}

export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const {
    capability: cap,
    tenantId,
    inputs,
    surface,
    policy,
    redactor,
    evidence,
    lease,
    runId,
  } = opts;

  const startedAt = new Date();
  const trace: TraceEntry[] = [];
  const outputs: Record<string, TypedValue> = {};

  const tenant = cap.tenants.find((t) => t.tenantId === tenantId);
  if (!tenant) {
    return failNow(
      'artifact_invalid',
      `Capability "${cap.id}" has no binding for tenant "${tenantId}". Available: ${cap.tenants.map((t) => t.tenantId).join(', ') || '(none)'}`,
      'Add a tenant binding, or run against a tenant the capability was recorded for.',
    );
  }

  const resolveOptions: ResolveOptions = { labelOverrides: tenant.labelOverrides };

  // Guards = capability-level rules plus anything this tenant needs on top.
  // Order matters: tenant rules come first so a tenant can shadow a base rule.
  const guards: OutcomeRule[] = [...tenant.additionalOutcomes, ...cap.outcomes];

  // --- input validation ---------------------------------------------------
  const inputCheck = validateInputs(cap.inputs, inputs);
  if (!inputCheck.ok) {
    return failNow('invalid_input', inputCheck.message, inputCheck.remediation);
  }
  // Secrets get registered for exact scrubbing before anything is logged.
  for (const p of cap.inputs) {
    if (p.sensitivity === 'secret' || p.sensitivity === 'pii') {
      const v = inputs[p.name];
      if (v) redactor.registerSecret(v);
    }
  }

  // --- confirmation gate --------------------------------------------------
  if (cap.policy.requiresConfirmation && opts.mode === 'unattended') {
    if (opts.confirmationToken !== cap.id) {
      return failNow(
        'policy_denied',
        `Capability "${cap.id}" commits state and requires confirmation for unattended invocation.`,
        `Re-invoke with confirm="${cap.id}".`,
      );
    }
  }

  // --- approval gate ------------------------------------------------------
  if (opts.mode === 'unattended' && cap.governance.approval !== 'approved') {
    return failNow(
      'policy_denied',
      `Capability "${cap.id}" is in state "${cap.governance.approval}" and may not run unattended.`,
      'Have a reviewer set governance.approval to "approved" after checking the steps.',
    );
  }

  evidence.info('replay_started', {
    capability: cap.id,
    version: cap.version,
    tenant: tenantId,
    mode: opts.mode,
    contentHash: cap.provenance.contentHash,
    steps: cap.steps.length,
  });

  let snapshot: SurfaceSnapshot = await surface.snapshot();

  // -------------------------------------------------------------------------
  // Step loop
  // -------------------------------------------------------------------------
  for (const step of cap.steps) {
    const stepStarted = Date.now();
    const timeoutMs = step.timeoutMs ?? policy.limits.defaultActionTimeoutMs;

    // Per-step recovery budget. Shared across attempts so a guard that keeps
    // re-firing cannot loop forever.
    let recoveryAttempts = 0;
    const maxRecoveries = 4;

    let attempt = 0;
    let stepDone = false;
    let lastFailure: ReplayResult | null = null;

    while (!stepDone) {
      attempt++;
      snapshot = await surface.snapshot();

      // --- 2. guards ------------------------------------------------------
      const hit = firstMatchingGuard(guards, step.id, { snapshot, resolveOptions });
      if (hit) {
        const outcome = await handleGuard({
          rule: hit,
          step,
          snapshot,
          opts,
          trace,
          outputs,
          resolveOptions,
          recoveryAttempts,
          maxRecoveries,
        });

        if (outcome.kind === 'recovered') {
          recoveryAttempts++;
          trace.push({
            stepId: step.id,
            intent: step.intent,
            action: step.act.action,
            risk: step.risk,
            startedAt: new Date(stepStarted).toISOString(),
            durationMs: Date.now() - stepStarted,
            status: 'recovered',
            recovery: { outcomeCode: hit.code, action: outcome.action, attempt: recoveryAttempts },
          });
          continue; // re-run the same step against the recovered screen
        }
        if (outcome.kind === 'terminal') {
          return outcome.result;
        }
      }

      // --- 2b. after a recovery, verify before repeating -------------------
      //
      // The same rule already applied after a human hand-back, and it belongs
      // here for the same reason: an intervention may have satisfied the step.
      //
      // Concretely, dismissing an interstitial navigates onward — often to
      // exactly where the step was trying to go. Blindly re-running the action
      // then re-triggers the interstitial, and a per-request advisory turns
      // into a livelock that only ends when the recovery budget runs out and
      // reports `recovery_exhausted` for something that was never broken.
      //
      // Gated on `recoveryAttempts > 0` deliberately: skipping any step whose
      // checkpoint already happens to hold would silently drop legitimate
      // repeated actions.
      if (recoveryAttempts > 0 && step.checkpoint) {
        snapshot = await surface.snapshot();
        if (evaluateCondition(step.checkpoint, { snapshot, resolveOptions })) {
          evidence.info('step_satisfied_by_recovery', { stepId: step.id, recoveries: recoveryAttempts });
          trace.push(entry(step, stepStarted, 'ok', undefined, 'checkpoint already satisfied after recovery'));
          stepDone = true;
          break;
        }
      }

      // --- 3. policy re-check ---------------------------------------------
      const intent = describeIntent(step, cap, tenant, inputs);
      const derivedRisk = policy.classify(intent);
      if (derivedRisk !== step.risk) {
        return fail(
          'policy_denied',
          `Step ${step.id} was recorded as risk "${step.risk}" but current policy classifies it as "${derivedRisk}".`,
          `Either the policy tightened or the artifact was modified. Re-record or re-review before running.`,
          step,
          `risk = ${step.risk}`,
          `risk = ${derivedRisk}`,
        );
      }

      const decision = policy.evaluate(intent, {
        mode: opts.mode,
        confirmationToken: opts.confirmationToken,
        capabilityId: cap.id,
      });

      if (!decision.allow) {
        // An irreversible step is the canonical case for bringing in a human
        // rather than simply failing — the work is valid, the authority is not.
        if (decision.risk === 'irreversible' && opts.allowEscalation !== false) {
          const esc = await escalate({
            opts,
            step,
            snapshot,
            trace,
            reason: decision.reason,
            guidance:
              `${decision.remediation} Complete this step manually if it is correct, then hand control back.`,
            trigger: 'policy_blocked_irreversible',
          });
          if (esc.kind === 'resumed') {
            snapshot = await surface.snapshot();
            evidence.info('resumed_after_operator', { stepId: step.id });
            // The operator may well have performed this step. Verify rather
            // than assume, and skip the action if the checkpoint already holds.
            if (step.checkpoint && evaluateCondition(step.checkpoint, { snapshot, resolveOptions })) {
              trace.push(entry(step, stepStarted, 'ok', undefined, 'completed by operator'));
              stepDone = true;
              break;
            }
            continue;
          }
          return esc.result;
        }

        return fail(
          'policy_denied',
          decision.reason,
          decision.remediation,
          step,
          'action permitted by policy',
          decision.reason,
        );
      }

      // --- 4/5. resolve and act -------------------------------------------
      let resolution: TraceEntry['resolution'];

      try {
        switch (step.act.action) {
          case 'navigate': {
            const url = detemplatize(step.act.url, tenant.baseUrl);
            await surface.act({ kind: 'navigate', url });
            break;
          }

          case 'waitFor': {
            const ok = await waitForCondition(
              step.act.condition,
              surface,
              resolveOptions,
              timeoutMs,
            );
            if (!ok) {
              lastFailure = fail(
                'timeout',
                `Timed out after ${timeoutMs}ms waiting for a condition.`,
                'Increase the step timeout, or check whether the application is degraded.',
                step,
                describeCondition(step.act.condition),
                'condition never became true',
              );
              throw new StepRetryable();
            }
            break;
          }

          case 'read':
            break;

          case 'press':
            await surface.act({ kind: 'press', key: step.act.key });
            break;

          case 'click':
          case 'type':
          case 'select': {
            const r = resolve(step.act.target, snapshot.nodes, resolveOptions);

            if (!r.ok) {
              lastFailure = fail(
                r.reason === 'ambiguous' ? 'target_ambiguous' : 'target_not_found',
                r.reason === 'ambiguous'
                  ? `Could not choose between ${r.candidates.length} similar controls for ${step.act.target.description}. Refusing to guess.`
                  : `No control on screen matched ${step.act.target.description} (best score ${Math.round(r.bestScore)}, threshold 55).`,
                r.reason === 'ambiguous'
                  ? 'Tighten the descriptor — add the container, or an ordinal — then re-verify.'
                  : 'The screen may have changed, or the run may not be where the artifact expects. Check the screenshot and the a11y snapshot in this run.',
                step,
                step.act.target.description,
                r.candidates.length
                  ? `closest candidates: ${r.candidates.map((c) => `${c.description} (${c.score})`).join('; ')}`
                  : 'no candidates on screen',
                r.candidates,
              );
              throw new StepRetryable();
            }

            resolution = {
              score: Math.round(r.score),
              runnerUpScore: r.runnerUpScore === null ? null : Math.round(r.runnerUpScore),
              matchedSignals: r.matchedSignals,
              missedSignals: r.missedSignals,
              candidateCount: r.candidateCount,
            };

            // A match that lost signals still worked, but it is the earliest
            // observable sign of tenant/version drift — surface it loudly.
            if (r.missedSignals.length) {
              evidence.warn('resolution_degraded', {
                stepId: step.id,
                matched: r.matchedSignals,
                missed: r.missedSignals,
                score: resolution.score,
                target: step.act.target.description,
              });
            }

            if (step.act.action === 'click') {
              await surface.act({ kind: 'click', handle: r.node.handle });
            } else {
              const value = resolveValue(step.act.value, inputs, outputs);
              if (value === undefined) {
                lastFailure = fail(
                  'invalid_input',
                  `Step ${step.id} needs a value that was not supplied.`,
                  'Pass the missing input parameter.',
                  step,
                  describeValueSource(step.act.value),
                  'no value available',
                );
                throw new StepRetryable();
              }
              await surface.act(
                step.act.action === 'type'
                  ? { kind: 'type', handle: r.node.handle, text: value, clearFirst: step.act.clearFirst }
                  : { kind: 'select', handle: r.node.handle, value },
              );
            }
            break;
          }
        }
      } catch (e) {
        if (!(e instanceof StepRetryable)) {
          lastFailure = fail(
            'surface_error',
            `Step ${step.id} failed on the surface: ${(e as Error).message}`,
            'Check the screenshot captured for this step.',
            step,
            'action to complete',
            (e as Error).message,
          );
        }

        if (attempt < step.retry.attempts) {
          evidence.warn('step_retry', { stepId: step.id, attempt, of: step.retry.attempts });
          await sleep(step.retry.backoffMs);
          continue;
        }
        return await finishFailure(lastFailure!, { opts, trace, outputs, step, snapshot });
      }

      // --- 6. checkpoint ---------------------------------------------------
      if (step.checkpoint) {
        const ok = await waitForCondition(step.checkpoint, surface, resolveOptions, timeoutMs);
        snapshot = await surface.snapshot();

        if (!ok) {
          // Before declaring a checkpoint failure, re-run the guards: the most
          // common reason a checkpoint fails is that a *different, declared*
          // screen appeared. A "no such member" page failing the member-detail
          // checkpoint is a business outcome, not a broken capability. This
          // single re-check is what keeps the taxonomy from collapsing.
          const guard = firstMatchingGuard(guards, step.id, { snapshot, resolveOptions });
          if (guard) {
            const outcome = await handleGuard({
              rule: guard,
              step,
              snapshot,
              opts,
              trace,
              outputs,
              resolveOptions,
              recoveryAttempts,
              maxRecoveries,
            });
            if (outcome.kind === 'recovered') {
              recoveryAttempts++;
              // Record it, exactly as the pre-step guard path does.
              //
              // Omitting this made recoveries triggered *after* a checkpoint
              // failure invisible in the trace — and that path is the common
              // one, because an interstitial usually announces itself by
              // making the previous step's checkpoint fail. The run recovered
              // correctly and reported no recoveries, so anything reading the
              // trace concluded the rule had never fired. It is the reason a
              // working `recoverable` detector kept showing up as UNVERIFIED.
              trace.push({
                stepId: step.id,
                intent: step.intent,
                action: step.act.action,
                risk: step.risk,
                startedAt: new Date(stepStarted).toISOString(),
                durationMs: Date.now() - stepStarted,
                status: 'recovered',
                recovery: { outcomeCode: guard.code, action: outcome.action, attempt: recoveryAttempts },
              });
              continue;
            }
            if (outcome.kind === 'terminal') return outcome.result;
          }

          lastFailure = fail(
            'checkpoint_failed',
            `Step ${step.id} ran but did not reach the expected state.`,
            'The action may not have taken effect, or the application returned a state this capability does not know about. If it is a legitimate outcome, declare it in the artifact.',
            step,
            explainFailure(step.checkpoint, { snapshot, resolveOptions }),
            `url=${snapshot.url}; text starts "${snapshot.text.slice(0, 160).replace(/\s+/g, ' ')}"`,
          );

          if (attempt < step.retry.attempts) {
            evidence.warn('checkpoint_retry', { stepId: step.id, attempt });
            await sleep(step.retry.backoffMs);
            continue;
          }
          return await finishFailure(lastFailure, { opts, trace, outputs, step, snapshot });
        }
      }

      trace.push(entry(step, stepStarted, 'ok', resolution));
      evidence.info('step_ok', {
        stepId: step.id,
        intent: step.intent,
        action: step.act.action,
        score: resolution?.score,
        url: snapshot.url,
      });
      stepDone = true;
    }
  }

  // -------------------------------------------------------------------------
  // Success checkpoint + extraction
  // -------------------------------------------------------------------------
  snapshot = await surface.snapshot();
  // Reassigned as recoveries re-observe the final screen.
  let ctx = { snapshot, resolveOptions };

  /**
   * Terminal guards are evaluated BEFORE the success checkpoint.
   *
   * A declared outcome is a more specific answer than "the flow finished", and
   * the two can both be true: a member who exists but holds no savings share
   * still renders the "Share Accounts" panel, so a success checkpoint keyed to
   * that panel passes while `no_savings_account` is also true. Checking
   * success first meant that outcome could never fire — the caller was told
   * the lookup succeeded, and then handed no balance.
   *
   * Ordering guards first is only safe because the compiler already refuses to
   * ship a detector that matches a screen the happy path passes through
   * (see `compile`), so a well-formed capability cannot have an outcome that
   * shadows its own success state.
   */
  const terminalGuard = firstMatchingGuard(guards, null, ctx);
  if (terminalGuard && terminalGuard.classification === 'business') {
    return businessOutcome(terminalGuard, cap, snapshot, ctx, opts, trace, null);
  }

  /**
   * The success checkpoint gets the same guard treatment every step gets.
   *
   * An earlier version only honoured `business` guards here, which left an
   * inconsistency with a real consequence: an interstitial that fires on every
   * request is still on screen when the last step finishes, so the success
   * checkpoint fails, and a `recoverable` rule that had been dismissing that
   * interstitial happily all run was suddenly ignored. The run failed on the
   * final screen for a condition it already knew how to clear.
   *
   * Bounded, because a guard that never clears must not loop forever — it
   * becomes `recovery_exhausted`, which is the honest answer.
   */
  const lastStep = cap.steps[cap.steps.length - 1]!;
  let finalRecoveries = 0;

  while (!evaluateCondition(cap.successCheckpoint, ctx)) {
    const guard = firstMatchingGuard(guards, null, ctx);

    if (guard && finalRecoveries < 4) {
      const outcome = await handleGuard({
        rule: guard,
        step: lastStep,
        snapshot,
        opts,
        trace,
        outputs,
        resolveOptions,
        recoveryAttempts: finalRecoveries,
        maxRecoveries: 4,
      });

      if (outcome.kind === 'terminal') return outcome.result;

      if (outcome.kind === 'recovered') {
        finalRecoveries++;
        trace.push({
          stepId: 'final',
          intent: 'reach the declared success state',
          action: 'verify',
          risk: 'safe',
          startedAt: new Date().toISOString(),
          durationMs: 0,
          status: 'recovered',
          recovery: { outcomeCode: guard.code, action: outcome.action, attempt: finalRecoveries },
        });
        snapshot = await surface.snapshot();
        ctx = { snapshot, resolveOptions };
        continue;
      }
    }

    return await finishFailure(
      fail(
        'checkpoint_failed',
        'All steps ran but the capability did not reach its declared success state.',
        'Compare the final screenshot against the success checkpoint; the flow may have a branch this recording never saw.',
        null,
        explainFailure(cap.successCheckpoint, ctx),
        `url=${snapshot.url}`,
      ),
      { opts, trace, outputs, step: null, snapshot },
    );
  }

  for (const field of cap.outputs) {
    const r = extract(field, ctx);
    if (!r.ok) {
      if (field.required) {
        return await finishFailure(
          fail(
            'checkpoint_failed',
            `Reached the success state but could not extract required output "${field.name}".`,
            'The value may be labelled differently at this institution. Add a labelOverride to the tenant binding.',
            null,
            r.problem ?? 'a value',
            'not found on the final screen',
          ),
          { opts, trace, outputs, step: null, snapshot },
        );
      }
      continue;
    }

    // Redaction applies to PERSISTENCE, not to the return channel.
    //
    // The caller is the institution's own agent, acting on a member record it
    // just asked about — withholding the balance from it makes the capability
    // useless, which is what an earlier version did. The actual risk is the
    // value coming to rest somewhere it should not: a JSONL log shipped to an
    // aggregator, an artifact in git, a screenshot in a ticket.
    //
    // So the value goes back to the caller in full, and is registered with the
    // redactor at the same moment — which scrubs it from this run's evidence,
    // including the result document written after replay returns.
    // Register BOTH forms: the raw string as scraped ("$55,023.10") and the
    // coerced value as stored (55023.1). They are different strings, and
    // registering only the raw one leaves the stored form unscrubbed.
    if (field.sensitivity === 'pii') {
      if (r.raw) redactor.registerSecret(String(r.raw));
      if (r.value !== undefined && r.value !== null) redactor.registerSecret(String(r.value));
    }

    outputs[field.name] = {
      value: r.value ?? null,
      sensitivity: field.sensitivity,
      // "was scrubbed from persisted evidence", not "was withheld from you".
      redacted: field.sensitivity === 'pii',
    };
  }

  const finishedAt = new Date();
  const meta = buildMeta(opts, startedAt, finishedAt, trace.length);
  evidence.info('replay_success', { outputs: Object.keys(outputs), durationMs: meta.durationMs });

  const result: ReplayResult = {
    status: 'success',
    meta,
    outputs,
    trace,
    evidence: evidence.evidence,
  };
  assertNoLlm(result);
  return result;

  // -------------------------------------------------------------------------
  // local helpers (closed over run state)
  // -------------------------------------------------------------------------

  function buildMeta(o: ReplayOptions, s: Date, f: Date, steps: number): RunMeta {
    return {
      runId,
      capabilityId: cap.id,
      capabilityVersion: cap.version,
      tenantId: o.tenantId,
      mode: 'replay',
      startedAt: s.toISOString(),
      finishedAt: f.toISOString(),
      durationMs: f.getTime() - s.getTime(),
      stepsAttempted: steps,
      evidenceDir: evidence.dir,
      llmCalls: 0,
    };
  }

  function failNow(
    kind: Parameters<typeof fail>[0],
    message: string,
    remediation: string,
  ): ReplayResult {
    const f = new Date();
    evidence.error('replay_failed', { kind, message });
    return {
      status: 'failure',
      meta: buildMeta(opts, startedAt, f, trace.length),
      failure: {
        kind,
        message,
        atStepId: null,
        stepIntent: null,
        expected: null,
        observed: null,
        remediation,
      },
      partialOutputs: outputs,
      trace,
      evidence: evidence.evidence,
    };
  }

  function fail(
    kind: import('../types/result.js').FailureKind,
    message: string,
    remediation: string,
    step: Step | null,
    expected: string | null,
    observed: string | null,
    candidates?: Array<{ description: string; score: number }>,
  ): ReplayResult {
    const f = new Date();
    return {
      status: 'failure',
      meta: buildMeta(opts, startedAt, f, trace.length),
      failure: {
        kind,
        message,
        atStepId: step?.id ?? null,
        stepIntent: step?.intent ?? null,
        expected,
        observed,
        remediation,
        candidates,
      },
      partialOutputs: outputs,
      trace,
      evidence: evidence.evidence,
    };
  }
}

// ---------------------------------------------------------------------------
// Guard handling
// ---------------------------------------------------------------------------

class StepRetryable extends Error {}

function firstMatchingGuard(
  guards: OutcomeRule[],
  stepId: string | null,
  ctx: { snapshot: SurfaceSnapshot; resolveOptions: ResolveOptions },
): OutcomeRule | undefined {
  return guards.find((g) => {
    if (Array.isArray(g.scope)) {
      if (stepId === null || !g.scope.includes(stepId)) return false;
    }
    return evaluateCondition(g.detect, ctx);
  });
}

type GuardOutcome =
  | { kind: 'none' }
  | { kind: 'recovered'; action: string }
  | { kind: 'terminal'; result: ReplayResult };

async function handleGuard(args: {
  rule: OutcomeRule;
  step: Step;
  snapshot: SurfaceSnapshot;
  opts: ReplayOptions;
  trace: TraceEntry[];
  outputs: Record<string, TypedValue>;
  resolveOptions: ResolveOptions;
  recoveryAttempts: number;
  maxRecoveries: number;
}): Promise<GuardOutcome> {
  const { rule, step, snapshot, opts, trace, outputs, resolveOptions } = args;
  const { evidence, surface, capability: cap } = opts;
  const ctx = { snapshot, resolveOptions };

  evidence.info('guard_matched', {
    code: rule.code,
    classification: rule.classification,
    stepId: step.id,
    url: snapshot.url,
  });

  switch (rule.classification) {
    case 'business': {
      return {
        kind: 'terminal',
        result: businessOutcome(rule, cap, snapshot, ctx, opts, trace, step.id),
      };
    }

    case 'recoverable': {
      if (args.recoveryAttempts >= args.maxRecoveries) {
        evidence.error('recovery_exhausted', { code: rule.code, attempts: args.recoveryAttempts });
        return {
          kind: 'terminal',
          result: {
            status: 'failure',
            meta: metaFor(opts, trace.length),
            failure: {
              kind: 'recovery_exhausted',
              outcomeCode: rule.code,
              message: `Recoverable condition "${rule.code}" kept recurring after ${args.recoveryAttempts} recovery attempts.`,
              atStepId: step.id,
              stepIntent: step.intent,
              expected: 'the condition to clear after recovery',
              observed: `"${rule.title}" still present`,
              remediation:
                'The recovery action is not clearing the condition. Check the recovery target, or reclassify the outcome.',
            },
            partialOutputs: outputs,
            trace,
            evidence: evidence.evidence,
          },
        };
      }

      const rec = rule.recovery!;
      evidence.info('recovery_applied', { code: rule.code, action: rec.do });

      /**
       * Verify the recovery actually did something before letting the step
       * retry.
       *
       * A recovery has to self-verify for the same reason a step needs a
       * checkpoint: dismissing an interstitial navigates a frame, and
       * snapshotting immediately afterwards catches the pre-navigation page.
       * The guard then re-fires on stale content and burns the budget with
       * nothing actually wrong.
       *
       * But the test is *progress*, not *permanent clearance*. Some
       * interstitials fire on every request, so acknowledging one is
       * immediately followed by another on the redirect target. That is a
       * second, legitimate occurrence — handled by looping recovery under the
       * attempt budget, which is what the budget is for. Demanding the
       * detector stay false would misreport that healthy case as a stuck
       * recovery, while a recovery that genuinely does nothing still fails
       * here because neither the URL nor the content moves.
       */
      // Frame URLs, not just the top document's — see SurfaceSnapshot.frameUrls.
      const fingerprint = (s: SurfaceSnapshot): string =>
        `${s.frameUrls.join('|')}|${s.text.slice(0, 400)}`;
      const before = fingerprint(snapshot);

      const recoveryMadeProgress = async (ms: number): Promise<boolean> => {
        const deadline = Date.now() + ms;
        for (;;) {
          const fresh = await surface.snapshot();
          if (!evaluateCondition(rule.detect, { snapshot: fresh, resolveOptions })) return true;
          if (fingerprint(fresh) !== before) return true; // a different occurrence
          if (Date.now() > deadline) return false;
          await sleep(250);
        }
      };

      switch (rec.do) {
        case 'click': {
          const r = resolve(rec.target, snapshot.nodes, resolveOptions);
          if (!r.ok) {
            evidence.warn('recovery_target_missing', {
              code: rule.code,
              target: rec.target.description,
              reason: r.reason,
              bestScore: Math.round(r.bestScore),
            });
            return { kind: 'none' };
          }
          await surface.act({ kind: 'click', handle: r.node.handle });
          const progressed = await recoveryMadeProgress(opts.policy.limits.defaultActionTimeoutMs);
          evidence.info('recovery_verified', { code: rule.code, progressed });
          if (!progressed) return { kind: 'none' };
          return { kind: 'recovered', action: `click ${rec.target.description}` };
        }
        case 'navigate': {
          const tenant = cap.tenants.find((t) => t.tenantId === opts.tenantId)!;
          await surface.act({ kind: 'navigate', url: detemplatize(rec.url, tenant.baseUrl) });
          const progressed = await recoveryMadeProgress(opts.policy.limits.defaultActionTimeoutMs);
          evidence.info('recovery_verified', { code: rule.code, progressed });
          if (!progressed) return { kind: 'none' };
          return { kind: 'recovered', action: `navigate ${rec.url}` };
        }
        case 'waitAndRetry': {
          await sleep(rec.waitMs);
          return { kind: 'recovered', action: `wait ${rec.waitMs}ms` };
        }
        case 'restartFromStep': {
          // Not implemented: restarting mid-flow can re-submit an already
          // committed step. Escalating is the honest response.
          evidence.warn('recovery_unsupported', { code: rule.code, action: rec.do });
          return { kind: 'none' };
        }
      }
      return { kind: 'none' };
    }

    case 'escalate': {
      if (opts.allowEscalation === false) {
        return {
          kind: 'terminal',
          result: {
            status: 'failure',
            meta: metaFor(opts, trace.length),
            failure: {
              kind: 'recovery_exhausted',
              message: `Outcome "${rule.code}" requires a human, but escalation is disabled for this run.`,
              atStepId: step.id,
              stepIntent: step.intent,
              expected: 'a state the automation can handle',
              observed: rule.title,
              remediation: 'Re-run with escalation enabled, or handle this state in the artifact.',
              // Name the rule that stopped the run. Without it, a verification
              // pass (which deliberately disables escalation so it never parks
              // on a human) cannot tell that the detector fired correctly, and
              // reports a working `escalate` rule as never having matched.
              outcomeCode: rule.code,
            },
            partialOutputs: outputs,
            trace,
            evidence: evidence.evidence,
          },
        };
      }

      const esc = await escalate({
        opts,
        step,
        snapshot,
        trace,
        reason: `${rule.title} — ${rule.code}`,
        guidance: rule.operatorGuidance ?? 'Resolve this state manually, then hand control back.',
        trigger: 'declared_outcome',
        outcomeCode: rule.code,
      });
      if (esc.kind === 'resumed') return { kind: 'recovered', action: 'operator intervention' };
      return { kind: 'terminal', result: esc.result };
    }

    case 'hard': {
      return {
        kind: 'terminal',
        result: {
          status: 'failure',
          meta: metaFor(opts, trace.length),
          failure: {
            kind: 'surface_error',
            outcomeCode: rule.code,
            message: `${rule.title} (${rule.code})`,
            atStepId: step.id,
            stepIntent: step.intent,
            expected: 'the application to respond normally',
            observed: rule.title,
            remediation: 'This is an application fault, not an automation fault. Check the target system.',
          },
          partialOutputs: outputs,
          trace,
          evidence: evidence.evidence,
        },
      };
    }
  }
}

function businessOutcome(
  rule: OutcomeRule,
  cap: Capability,
  snapshot: SurfaceSnapshot,
  ctx: { snapshot: SurfaceSnapshot; resolveOptions: ResolveOptions },
  opts: ReplayOptions,
  trace: TraceEntry[],
  atStepId: string | null,
): ReplayResult {
  const details: Record<string, TypedValue> = {};
  for (const field of rule.extract) {
    const r = extract(field, ctx);
    if (r.ok) {
      // Same rule as the success path: returned to the caller, scrubbed from
      // anything written to disk — in both its raw and coerced forms.
      if (field.sensitivity === 'pii') {
        if (r.raw) opts.redactor.registerSecret(String(r.raw));
        if (r.value !== undefined && r.value !== null) opts.redactor.registerSecret(String(r.value));
      }
      details[field.name] = {
        value: r.value ?? null,
        sensitivity: field.sensitivity,
        redacted: field.sensitivity === 'pii',
      };
    }
  }

  opts.evidence.info('business_outcome', { code: rule.code, title: rule.title, url: snapshot.url });

  const result: ReplayResult = {
    status: 'outcome',
    meta: metaFor(opts, trace.length),
    outcome: rule.code,
    outcomeTitle: rule.title,
    classification: 'business',
    details,
    atStepId: atStepId ?? cap.steps[cap.steps.length - 1]?.id ?? 'unknown',
    trace,
    evidence: opts.evidence.evidence,
  };
  assertNoLlm(result);
  return result;
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

async function escalate(args: {
  opts: ReplayOptions;
  step: Step | null;
  snapshot: SurfaceSnapshot;
  trace: TraceEntry[];
  reason: string;
  guidance: string;
  trigger: 'declared_outcome' | 'policy_blocked_irreversible' | 'recovery_exhausted' | 'no_progress';
  outcomeCode?: string;
}): Promise<{ kind: 'resumed' } | { kind: 'terminal'; result: ReplayResult }> {
  const { opts, step, snapshot, trace, reason, guidance, trigger } = args;
  const { evidence, surface, lease, capability: cap } = opts;

  const shot = await surface.screenshot();
  const shotRef = evidence.saveScreenshot(`escalation-${step?.id ?? 'final'}`, shot);
  const snapRef = evidence.saveSnapshot(`escalation-${step?.id ?? 'final'}`, snapshot);

  const intervention = broker.create(
    {
      runId: opts.runId,
      capabilityId: cap.id,
      capabilityName: cap.name,
      tenantId: opts.tenantId,
      goal: cap.description,
      trigger,
      reason,
      guidance,
      atStepId: step?.id ?? null,
      stepIntent: step?.intent ?? null,
      currentUrl: snapshot.url,
      screenshotPath: shotRef.path,
      snapshotPath: snapRef.path,
    },
    lease,
    () => surface.screenshot(),
  );

  const url = `${opts.operatorBaseUrl ?? 'http://localhost:4400'}/i/${intervention.id}`;

  evidence.warn('escalated', {
    interventionId: intervention.id,
    trigger,
    reason,
    operatorUrl: url,
    stepId: step?.id,
  });

  // eslint-disable-next-line no-console
  console.log(`\n  ⚠  Human needed — ${reason}\n     ${url}\n`);

  // Record what the operator does while they hold the lease.
  const anySurface = surface as unknown as {
    captureHumanActions?: (cb: (a: Record<string, unknown>) => void) => Promise<void>;
  };
  await anySurface.captureHumanActions?.((a) => {
    broker.recordHumanAction(intervention.id, {
      at: String(a['at'] ?? new Date().toISOString()),
      type: (String(a['type'] ?? 'note') as 'click' | 'change' | 'submit' | 'note'),
      target: a['target'] as string | undefined,
      role: a['role'] as string | undefined,
      label: a['label'] as string | undefined,
      value: a['value'] as string | undefined,
      url: a['url'] as string | undefined,
    });
  });

  const waited = await lease.waitForHandBack(opts.escalationWaitMs ?? 15 * 60_000);
  const item = broker.get(intervention.id);

  if (waited === 'handed_back' && item?.status === 'handed_back') {
    lease.resume(`operator completed: ${item.resolutionNote ?? 'no note'}`);
    broker.markResolved(intervention.id, 'automation resumed');
    evidence.info('operator_handed_back', {
      interventionId: intervention.id,
      actions: item.humanActions.length,
      note: item.resolutionNote,
    });
    evidence.saveJson(`intervention-${intervention.id}`, item);
    return { kind: 'resumed' };
  }

  evidence.saveJson(`intervention-${intervention.id}`, item ?? { id: intervention.id, status: waited });

  const result: ReplayResult = {
    status: 'escalated',
    meta: metaFor(opts, trace.length),
    interventionId: intervention.id,
    outcomeCode: args.outcomeCode,
    reason,
    guidance,
    atStepId: step?.id ?? 'final',
    operatorUrl: url,
    trace,
    evidence: evidence.evidence,
  };
  assertNoLlm(result);
  return { kind: 'terminal', result };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

async function finishFailure(
  failure: ReplayResult,
  args: {
    opts: ReplayOptions;
    trace: TraceEntry[];
    outputs: Record<string, TypedValue>;
    step: Step | null;
    snapshot: SurfaceSnapshot;
  },
): Promise<ReplayResult> {
  const { opts, step } = args;
  // The richer signal on failure the brief asks for: a screenshot, the raw
  // markup, and — most useful of all — the normalized snapshot the resolver
  // was actually looking at when it gave up.
  try {
    opts.evidence.saveScreenshot(`failure-${step?.id ?? 'final'}`, await opts.surface.screenshot());
    opts.evidence.saveDom(`failure-${step?.id ?? 'final'}`, await opts.surface.dump());
    opts.evidence.saveSnapshot(`failure-${step?.id ?? 'final'}`, args.snapshot);
  } catch {
    /* evidence capture must never mask the original failure */
  }

  if (failure.status === 'failure') {
    args.trace.push({
      stepId: step?.id ?? 'final',
      intent: step?.intent ?? 'final checkpoint',
      action: step?.act.action ?? 'verify',
      risk: step?.risk ?? 'safe',
      startedAt: new Date().toISOString(),
      durationMs: 0,
      status: 'failed',
      note: failure.failure.message,
    });
    opts.evidence.error('replay_failed', {
      kind: failure.failure.kind,
      stepId: failure.failure.atStepId,
      expected: failure.failure.expected,
      observed: failure.failure.observed,
    });
  }
  assertNoLlm(failure);
  return failure;
}

async function waitForCondition(
  cond: Condition,
  surface: Surface,
  resolveOptions: ResolveOptions,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Poll rather than sleep-then-check: a fixed wait is both slower on the happy
  // path and wrong on the slow path, which is the classic flaky-test failure.
  for (;;) {
    const snapshot = await surface.snapshot();
    if (evaluateCondition(cond, { snapshot, resolveOptions })) return true;
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

function describeIntent(
  step: Step,
  cap: Capability,
  tenant: TenantBinding,
  _inputs: Record<string, string>,
): Parameters<PolicyEngine['classify']>[0] {
  const act = step.act;
  switch (act.action) {
    case 'navigate':
      return { kind: 'navigate', url: detemplatize(act.url, tenant.baseUrl) };
    case 'click':
      return {
        kind: 'click',
        targetName: act.target.name ?? act.target.label,
        targetContainer: act.target.container,
      };
    case 'type':
      return { kind: 'type', fieldLabel: act.target.label ?? act.target.name, targetName: act.target.name };
    case 'select':
      return { kind: 'select', fieldLabel: act.target.label ?? act.target.name, targetName: act.target.name };
    case 'press':
      return { kind: 'press' };
    default:
      return { kind: 'read' };
  }
}

function resolveValue(
  src: ValueSource,
  inputs: Record<string, string>,
  outputs: Record<string, TypedValue>,
): string | undefined {
  switch (src.from) {
    case 'literal':
      return src.value;
    case 'param':
      return inputs[src.name];
    case 'secret':
      // Secrets come from the invocation, never from the artifact.
      return inputs[src.ref] ?? process.env[`HANDSPAN_SECRET_${src.ref.toUpperCase()}`];
    case 'output': {
      const v = outputs[src.name]?.value;
      return v === null || v === undefined ? undefined : String(v);
    }
  }
}

function describeValueSource(src: ValueSource): string {
  switch (src.from) {
    case 'literal':
      return 'a literal value';
    case 'param':
      return `input parameter "${src.name}"`;
    case 'secret':
      return `secret "${src.ref}"`;
    case 'output':
      return `earlier output "${src.name}"`;
  }
}

function validateInputs(
  declared: InputParam[],
  supplied: Record<string, string>,
): { ok: true } | { ok: false; message: string; remediation: string } {
  const missing = declared.filter((p) => p.required && !supplied[p.name]).map((p) => p.name);
  if (missing.length) {
    return {
      ok: false,
      message: `Missing required input(s): ${missing.join(', ')}`,
      remediation: `Supply them, e.g. --input ${missing[0]}=<value>`,
    };
  }

  for (const p of declared) {
    const v = supplied[p.name];
    if (v === undefined) continue;
    if (p.pattern && !new RegExp(p.pattern).test(v)) {
      return {
        ok: false,
        message: `Input "${p.name}" does not match the declared pattern ${p.pattern}.`,
        remediation: 'Correct the value.',
      };
    }
    if (p.type === 'number' || p.type === 'money') {
      if (!Number.isFinite(Number(v.replace(/[,$£€\s]/g, '')))) {
        return {
          ok: false,
          message: `Input "${p.name}" is declared ${p.type} but "${v}" is not numeric.`,
          remediation: 'Supply a numeric value.',
        };
      }
    }
    if (p.type === 'enum' && p.enumValues?.length && !p.enumValues.includes(v)) {
      return {
        ok: false,
        message: `Input "${p.name}" must be one of: ${p.enumValues.join(', ')} (got "${v}").`,
        remediation: 'Supply a permitted value.',
      };
    }
  }
  return { ok: true };
}

function entry(
  step: Step,
  startedMs: number,
  status: TraceEntry['status'],
  resolution?: TraceEntry['resolution'],
  note?: string,
): TraceEntry {
  return {
    stepId: step.id,
    intent: step.intent,
    action: step.act.action,
    risk: step.risk,
    startedAt: new Date(startedMs).toISOString(),
    durationMs: Date.now() - startedMs,
    status,
    resolution,
    note,
  };
}

function metaFor(opts: ReplayOptions, steps: number): RunMeta {
  const now = new Date();
  return {
    runId: opts.runId,
    capabilityId: opts.capability.id,
    capabilityVersion: opts.capability.version,
    tenantId: opts.tenantId,
    mode: 'replay',
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    durationMs: 0,
    stepsAttempted: steps,
    evidenceDir: opts.evidence.dir,
    llmCalls: 0,
  };
}

/**
 * The claim "no model in the decision loop" is worth checking, not asserting.
 * Cheap, and it fails loudly if someone later wires a model into this path.
 */
function assertNoLlm(result: ReplayResult): void {
  if (result.meta.llmCalls !== 0) {
    throw new Error(
      `Invariant violated: the replay path made ${result.meta.llmCalls} model call(s). Replay must be deterministic.`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
