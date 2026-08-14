/**
 * The replay result contract.
 *
 * The brief names conflating a business outcome with a failure as the most
 * common design mistake here, so the contract makes them different *shapes*,
 * not different values of a `status` string. A caller that pattern-matches on
 * `status` cannot accidentally treat "no such member" as a crash, because the
 * success and outcome branches carry different fields.
 *
 * Four terminal shapes:
 *
 *   success   — the checkpoint passed; `outputs` is populated and typed.
 *   outcome   — a declared business outcome fired. This is a *successful run*
 *               that produced a different answer. Exit code 0.
 *   escalated — the run paused and handed the live session to a human. Carries
 *               everything needed to resume.
 *   failure   — hard stop. Carries step, expectation, observation, and evidence
 *               pointers, because "it failed" with no diff is not debuggable.
 *
 * Recoverable conditions are deliberately NOT terminal states — they are
 * handled inside the engine and reported in `trace` as recovery events. If a
 * recoverable condition can't be recovered from, it is promoted to a failure
 * with `kind: "recovery_exhausted"`, which keeps the taxonomy honest.
 */

import type { OutcomeClass, RiskClass, Sensitivity } from './artifact.js';

export type FailureKind =
  /** The descriptor matched nothing on the live surface. */
  | 'target_not_found'
  /** The descriptor matched several candidates with no clear winner. Refusing
   *  to guess is the point: acting on the wrong control is worse than stopping. */
  | 'target_ambiguous'
  /** The action ran but the post-condition did not hold. */
  | 'checkpoint_failed'
  /** Wall-clock budget for a step or the whole run was exhausted. */
  | 'timeout'
  /** A recoverable condition kept recurring past its attempt budget. */
  | 'recovery_exhausted'
  /** The action was refused by the allowlist or risk policy. */
  | 'policy_denied'
  /** Caller-supplied inputs failed the declared schema. */
  | 'invalid_input'
  /** The app itself broke — 5xx, crashed frame, navigation error. */
  | 'surface_error'
  /** The artifact is malformed or fails structural validation. */
  | 'artifact_invalid'
  /** Anything genuinely unexpected. Should be rare; investigated when seen. */
  | 'internal_error';

export interface EvidenceRef {
  kind: 'screenshot' | 'dom_snapshot' | 'a11y_snapshot' | 'log' | 'trace';
  path: string;
  capturedAt: string;
}

/** One entry per attempted step, whatever the eventual result. */
export interface TraceEntry {
  stepId: string;
  intent: string;
  action: string;
  risk: RiskClass;
  startedAt: string;
  durationMs: number;
  status: 'ok' | 'recovered' | 'skipped' | 'failed';
  /** How the target was resolved, so drift is visible without a debugger. */
  resolution?: {
    score: number;
    runnerUpScore: number | null;
    matchedSignals: string[];
    /** Signals the descriptor declared that did NOT match. The drift signal. */
    missedSignals: string[];
    candidateCount: number;
  };
  /** Present when a recoverable outcome fired during this step. */
  recovery?: { outcomeCode: string; action: string; attempt: number };
  note?: string;
}

export interface RunMeta {
  runId: string;
  capabilityId: string;
  capabilityVersion: number;
  tenantId: string;
  mode: 'discovery' | 'replay';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stepsAttempted: number;
  evidenceDir: string;
  /** Zero on the replay path, always. Proves the LLM was not in the loop. */
  llmCalls: number;
}

export interface TypedValue {
  value: string | number | boolean | null;
  sensitivity: Sensitivity;
  /**
   * True when this value was scrubbed from the run's PERSISTED evidence —
   * logs, snapshots, the saved result document.
   *
   * It does not mean the value was withheld from the caller. Regulated data is
   * returned in full to the agent that asked for it, because that agent is
   * operating on the record legitimately; what must not happen is the value
   * coming to rest in a log file. Conflating the two produced a capability
   * that dutifully returned "[REDACTED]" as the account balance it existed to
   * fetch.
   *
   * `secret`-classified values are a separate matter: the schema forbids them
   * as outputs at all, so they never reach this type.
   */
  redacted: boolean;
}

export interface ReplaySuccess {
  status: 'success';
  meta: RunMeta;
  outputs: Record<string, TypedValue>;
  trace: TraceEntry[];
  evidence: EvidenceRef[];
}

export interface ReplayOutcome {
  status: 'outcome';
  meta: RunMeta;
  /** The declared `OutcomeRule.code`. Callers switch on this. */
  outcome: string;
  outcomeTitle: string;
  classification: Extract<OutcomeClass, 'business'>;
  /** Whatever the rule declared worth extracting, e.g. the searched-for id. */
  details: Record<string, TypedValue>;
  atStepId: string;
  trace: TraceEntry[];
  evidence: EvidenceRef[];
}

export interface ReplayEscalated {
  status: 'escalated';
  meta: RunMeta;
  interventionId: string;
  /** The declared rule that triggered this, when it was a declared outcome. */
  outcomeCode?: string;
  reason: string;
  /** What the operator is being asked to do. */
  guidance: string;
  atStepId: string;
  /** Live while the operator holds the lease; the session is not torn down. */
  operatorUrl: string;
  trace: TraceEntry[];
  evidence: EvidenceRef[];
}

export interface ReplayFailure {
  status: 'failure';
  meta: RunMeta;
  failure: {
    kind: FailureKind;
    /** One line, safe to surface to an on-call human. */
    message: string;
    atStepId: string | null;
    stepIntent: string | null;
    /** The three fields that make a failure actionable. */
    expected: string | null;
    observed: string | null;
    remediation: string | null;
    /** Populated for target_ambiguous so you can see what it couldn't choose. */
    candidates?: Array<{ description: string; score: number }>;
    /**
     * The declared outcome rule that produced this failure, when one did.
     *
     * Without it, "surface_error" gives no clue that the capability *predicted*
     * this state and classified it `hard` — you cannot tell a rule that fired
     * from a rule that is silently dead, which is exactly what outcome
     * verification needs to know.
     */
    outcomeCode?: string;
  };
  /** Partial outputs collected before the failure. Often the useful part. */
  partialOutputs: Record<string, TypedValue>;
  trace: TraceEntry[];
  evidence: EvidenceRef[];
}

export type ReplayResult = ReplaySuccess | ReplayOutcome | ReplayEscalated | ReplayFailure;

/**
 * Process exit codes. A business outcome exits 0 — it is a valid answer, and a
 * scheduler that retries on non-zero must not retry "no such member".
 */
export function exitCodeFor(result: ReplayResult): number {
  switch (result.status) {
    case 'success':
      return 0;
    case 'outcome':
      return 0;
    case 'escalated':
      return 75; // EX_TEMPFAIL — work is parked, not lost
    case 'failure':
      return 1;
  }
}

export function isTerminalSuccess(r: ReplayResult): r is ReplaySuccess | ReplayOutcome {
  return r.status === 'success' || r.status === 'outcome';
}

/** Compact one-line summary for logs and CLI output. */
export function summarize(r: ReplayResult): string {
  switch (r.status) {
    case 'success': {
      const keys = Object.keys(r.outputs);
      return `SUCCESS — ${keys.length} output(s): ${keys.join(', ') || '(none)'}`;
    }
    case 'outcome':
      return `BUSINESS OUTCOME — ${r.outcome} (${r.outcomeTitle}) at step ${r.atStepId}`;
    case 'escalated':
      return `ESCALATED — ${r.reason} at step ${r.atStepId} (intervention ${r.interventionId})`;
    case 'failure':
      return `FAILURE — ${r.failure.kind} at step ${r.failure.atStepId ?? '(pre-flight)'}: ${r.failure.message}`;
  }
}
