/**
 * Drift analysis.
 *
 * The brief asks (§3.7) how per-tenant and per-version drift is *detected and
 * managed* across hundreds of institutions running the same vendor product.
 * Execution is not the thing that does not scale — knowing which of your
 * thousands of bindings quietly stopped matching is.
 *
 * The observation this module is built on: the replay engine already knows.
 * Every resolution records which declared signals matched, which did not, and
 * what the winning node actually looked like, and a resolution failure records
 * the candidates it was choosing between with their scores. That is a complete
 * drift signal, already in the trace, already redacted, already persisted with
 * every run. Nothing new needs to be instrumented — it needs to be *read*.
 *
 * So this is a pure function from a finished `ReplayResult` to a report. No
 * I/O, no browser, no model. It can run over a live run or over a `result.json`
 * captured weeks ago, which is what makes fleet-wide analysis a batch job over
 * evidence rather than a re-run of every capability.
 *
 * The classification that matters is the distinction between two things that
 * look identical in a log:
 *
 *   VOCABULARY — the institution renamed a thing. "Member ID" is now "Member
 *                Number". The flow is intact; a tenant binding absorbs it, and
 *                no re-recording is needed.
 *   STRUCTURAL — the panel a control lives in was renamed or the control moved
 *                frames. The descriptor still resolves, but it now means
 *                something slightly different, and a human should look.
 *   MISSING    — the control is not on screen at all. Either the flow changed
 *                or the run was not where the artifact expected it to be. Not
 *                repairable by renaming anything.
 *   AMBIGUOUS  — several candidates tie. The descriptor is under-specified for
 *                this surface; it needs tightening, not translating.
 *   CHECKPOINT — the step ran but the condition proving it worked no longer
 *                matches. This is drift in how the flow is VERIFIED rather
 *                than in how controls are found, and it is the dangerous one:
 *                the cheap way to make it go away is to loosen the assertion,
 *                which converts a broken capability into one that reports
 *                success. Detected here, never auto-repaired — see
 *                `src/repair/propose.ts`.
 *
 * Conflating vocabulary with structural drift is how you end up "fixing" a
 * capability by renaming a label when the flow itself moved.
 */

import type { Capability } from '../types/artifact.js';
import type { ReplayResult, TraceEntry } from '../types/result.js';

export type DriftKind = 'vocabulary' | 'structural' | 'missing' | 'ambiguous' | 'checkpoint';

export interface DriftFinding {
  stepId: string;
  intent: string;
  kind: DriftKind;
  /** The signal that stopped matching: 'label', 'container', 'name', ... */
  signal: string;
  /** What the artifact declared. */
  expected: string;
  /** What the surface presented instead, when that is knowable. */
  observed?: string;
  /** Match score at the time. Low-but-passing is the early warning. */
  score?: number;
  /**
   * True when the step still succeeded. Degraded-but-working is the state you
   * want to catch, because it is the one that turns into an outage later
   * without anything having failed in between.
   */
  survived: boolean;
}

export interface LabelRename {
  from: string;
  to: string;
  /** How many steps agree on this rename. One is a guess; three is a fact. */
  occurrences: number;
}

export interface DriftReport {
  capabilityId: string;
  capabilityVersion: number;
  tenantId: string;
  runId: string;
  analyzedAt: string;
  /**
   * stable   — every signal matched.
   * degraded — signals were lost but the run still completed. Act before it
   *            becomes `broken`; this is the window the report exists for.
   * broken   — the run did not complete, and resolution is why.
   */
  status: 'stable' | 'degraded' | 'broken';
  stepsAnalyzed: number;
  findings: DriftFinding[];
  /**
   * Renames that appear consistently enough to be worth proposing as a tenant
   * label overlay. This is the machine-actionable part of the report and the
   * input to a repair proposal.
   */
  suggestedLabelOverrides: LabelRename[];
  /** Plain-language summary lines, in severity order. */
  summary: string[];
}

/**
 * A signal is only evidence of vocabulary drift if we can see what replaced it.
 * `missedSignals` alone tells you something changed; pairing it with the
 * observed node tells you what to do about it.
 */
function findingsForStep(step: TraceEntry, cap: Capability): DriftFinding[] {
  const out: DriftFinding[] = [];
  const r = step.resolution;
  const declared = declaredTarget(cap, step.stepId);

  if (!r) return out;

  for (const signal of r.missedSignals) {
    const expected = declaredSignal(declared, signal);
    if (expected === undefined) continue;

    const observed =
      signal === 'label' ? r.observed?.label
      : signal === 'name' ? r.observed?.name
      : signal === 'container' ? r.observed?.container
      : undefined;

    out.push({
      stepId: step.stepId,
      intent: step.intent,
      // A renamed container changes what the descriptor *means*; a renamed
      // label changes only what it is called. Different fixes, different risk.
      kind: signal === 'container' || signal === 'framePath' ? 'structural' : 'vocabulary',
      signal,
      expected,
      ...(observed ? { observed } : {}),
      score: r.score,
      survived: step.status === 'ok' || step.status === 'recovered',
    });
  }

  return out;
}

function declaredTarget(cap: Capability, stepId: string) {
  const step = cap.steps.find((s) => s.id === stepId);
  if (!step || !('target' in step.act)) return undefined;
  return step.act.target;
}

function declaredSignal(
  target: ReturnType<typeof declaredTarget>,
  signal: string,
): string | undefined {
  if (!target) return undefined;
  switch (signal) {
    case 'label':
      return target.label;
    case 'name':
      return target.name;
    case 'container':
      return target.container;
    case 'framePath':
      return target.framePath.join('/') || undefined;
    default:
      return undefined;
  }
}

/**
 * Read a rename off the candidate list of a resolution that failed outright.
 *
 * When "Member ID" becomes "Member Number", the right control is still on
 * screen with its role, container and position intact — it just lost the 40
 * points that its label was carrying, and fell under the floor or inside the
 * margin. The information needed to explain the failure is therefore sitting in
 * the candidates the resolver rejected, and recovering it turns the most severe
 * finding back into the most actionable one.
 *
 * Three guards, because a wrong answer here proposes editing an artifact:
 *
 *   1. Same role. A textbox does not become a button in a re-wording.
 *   2. Shares a word with the old label. A rename almost always keeps one —
 *      "Member ID" -> "Member Number" keeps "member". This is what separates
 *      the right candidate from the "Last Name" box sitting two points below
 *      it in the same panel, which is exactly the pair that made the run
 *      ambiguous in the first place.
 *   3. Exactly one candidate survives both. If two do, the evidence genuinely
 *      is ambiguous and the honest output is `ambiguous`, not a guess.
 *
 * Container is deliberately *not* required to match. It is a weak signal by
 * design, and it can be wrong in the artifact itself — a descriptor recorded
 * while a validation banner was on screen ended up with the banner's text as
 * its container. Requiring it would make this refuse to fire precisely where
 * it is most needed.
 */
export function inferRename(
  declared: { role?: string; label?: string } | undefined,
  candidates: ReadonlyArray<{ role?: string; label?: string }> | undefined,
): { from: string; to: string } | undefined {
  if (!declared?.label || !declared.role || !candidates?.length) return undefined;

  const declaredWords = words(declared.label);
  if (!declaredWords.length) return undefined;

  const plausible = candidates.filter(
    (c) =>
      c.role === declared.role &&
      c.label &&
      c.label !== declared.label &&
      words(c.label).some((w) => declaredWords.includes(w)),
  );

  const only = plausible.length === 1 ? plausible[0] : undefined;
  return only?.label ? { from: declared.label, to: only.label } : undefined;
}

/** Words worth matching on. Short tokens carry no signal and create matches. */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

export function analyzeRun(cap: Capability, result: ReplayResult): DriftReport {
  const findings: DriftFinding[] = [];

  for (const step of result.trace) {
    findings.push(...findingsForStep(step, cap));
  }

  // A resolution failure is drift too — the most severe kind — but it arrives
  // through the failure object rather than the trace, because the step never
  // produced a resolution to record.
  if (result.status === 'failure') {
    const f = result.failure;
    if (f.kind === 'checkpoint_failed') {
      findings.push({
        stepId: f.atStepId ?? '(unknown)',
        intent: f.stepIntent ?? '',
        kind: 'checkpoint',
        signal: 'checkpoint',
        expected: f.expected ?? '(unknown condition)',
        ...(f.observed ? { observed: f.observed } : {}),
        survived: false,
      });
    }

    if (f.kind === 'target_not_found' || f.kind === 'target_ambiguous') {
      const declared = f.atStepId ? declaredTarget(cap, f.atStepId) : undefined;

      const renamed = inferRename(declared, f.candidates);

      findings.push({
        stepId: f.atStepId ?? '(unknown)',
        intent: f.stepIntent ?? '',
        // A failure we can explain as a rename is still vocabulary drift; it
        // is only `missing` or `ambiguous` when we cannot account for it.
        kind: renamed ? 'vocabulary' : f.kind === 'target_ambiguous' ? 'ambiguous' : 'missing',
        signal: renamed ? 'label' : 'target',
        expected: renamed
          ? renamed.from
          : (declared?.description ?? f.expected ?? '(unknown target)'),
        ...(renamed
          ? { observed: renamed.to }
          : f.observed
            ? { observed: f.observed }
            : {}),
        ...(f.candidates?.[0] ? { score: f.candidates[0].score } : {}),
        survived: false,
      });
    }
  }

  const status: DriftReport['status'] =
    findings.some((f) => !f.survived) ? 'broken'
    : findings.length ? 'degraded'
    : 'stable';

  return {
    capabilityId: cap.id,
    capabilityVersion: cap.version,
    tenantId: result.meta.tenantId,
    runId: result.meta.runId,
    analyzedAt: new Date().toISOString(),
    status,
    stepsAnalyzed: result.trace.length,
    findings,
    suggestedLabelOverrides: proposeRenames(findings),
    summary: summarize(findings, status),
  };
}

/**
 * Roll findings up into renames worth acting on.
 *
 * Only vocabulary findings with both sides observed qualify. A structural
 * finding is deliberately excluded: renaming a panel in a binding would paper
 * over a layout change that a person needs to look at.
 *
 * Occurrences are counted because agreement is the whole signal. One step
 * seeing "Member ID" resolve against "Member Number" could be a coincidence of
 * scoring; three steps agreeing is the institution's vocabulary.
 */
export function proposeRenames(findings: DriftFinding[]): LabelRename[] {
  const counts = new Map<string, LabelRename>();

  for (const f of findings) {
    if (f.kind !== 'vocabulary') continue;
    if (!f.observed || !f.expected) continue;
    if (f.observed.trim() === '' || f.observed === f.expected) continue;

    const key = `${f.expected} ${f.observed}`;
    const prev = counts.get(key);
    if (prev) prev.occurrences += 1;
    else counts.set(key, { from: f.expected, to: f.observed, occurrences: 1 });
  }

  return [...counts.values()].sort((a, b) => b.occurrences - a.occurrences);
}

function summarize(findings: DriftFinding[], status: DriftReport['status']): string[] {
  if (status === 'stable') return ['Every declared signal matched. No drift detected.'];

  const lines: string[] = [];
  const broken = findings.filter((f) => !f.survived);
  const vocab = findings.filter((f) => f.kind === 'vocabulary');
  const structural = findings.filter((f) => f.kind === 'structural' && f.survived);

  for (const f of broken) {
    if (f.kind === 'vocabulary') continue; // reported in the vocabulary line below
    if (f.kind === 'checkpoint') {
      lines.push(
        `${f.stepId}: the checkpoint proving this step worked no longer matches (expected ${f.expected}). ` +
          `This is verification drift, not targeting drift — it is NOT auto-repairable, because the only ` +
          `way to make it pass is to weaken the assertion, and a capability that cannot prove it worked ` +
          `is worse than one that fails.`,
      );
      continue;
    }
    lines.push(
      f.kind === 'ambiguous'
        ? `${f.stepId}: several controls tie for "${f.expected}". The descriptor is under-specified on this surface — tighten it, do not translate it.`
        : `${f.stepId}: no control matched "${f.expected}". Either the flow changed or the run was not where the artifact expected. Not fixable by renaming.`,
    );
  }
  for (const f of structural) {
    lines.push(
      `${f.stepId}: ${f.signal} drift — declared "${f.expected}"${f.observed ? `, found "${f.observed}"` : ', not found'}. Structural: the descriptor still resolves but now means something slightly different. A person should look.`,
    );
  }
  if (vocab.length) {
    const shown = vocab
      .map((f) => `"${f.expected}" -> "${f.observed ?? '?'}"`)
      .filter((v, i, a) => a.indexOf(v) === i);
    const fatal = vocab.filter((f) => !f.survived).length;
    lines.push(
      `Vocabulary drift on ${vocab.length} step(s): ${shown.join(', ')}. ` +
        (fatal
          ? `${fatal} of them stopped resolving entirely — the control kept its role and container, so the rename is the whole explanation. `
          : '') +
        `The flow is intact; a tenant binding absorbs this without re-recording.`,
    );
  }

  return lines;
}

/** Terminal rendering. Kept out of the analysis so the analysis stays pure. */
export function renderReport(report: DriftReport): string {
  const bar = '─'.repeat(88);
  const lines: string[] = [];

  lines.push('');
  lines.push(`  Drift report — ${report.capabilityId} v${report.capabilityVersion} @ ${report.tenantId}`);
  lines.push(`  ${bar}`);
  lines.push(`  status        ${report.status.toUpperCase()}`);
  lines.push(`  steps         ${report.stepsAnalyzed} analyzed, ${report.findings.length} finding(s)`);
  lines.push(`  run           ${report.runId}`);
  lines.push(`  ${bar}`);

  if (report.findings.length) {
    lines.push('');
    for (const f of report.findings) {
      const state = f.survived ? 'degraded' : 'FAILED  ';
      lines.push(
        `  ${state}  ${f.stepId.padEnd(5)} ${f.kind.padEnd(11)} ${f.signal.padEnd(10)} ` +
          `declared "${f.expected}"${f.observed ? ` / found "${f.observed}"` : ''}` +
          `${f.score === undefined ? '' : `  (score ${f.score})`}`,
      );
    }
  }

  lines.push('');
  for (const s of report.summary) lines.push(`  ${s}`);

  if (report.suggestedLabelOverrides.length) {
    lines.push('');
    lines.push('  Proposed label overlay:');
    for (const r of report.suggestedLabelOverrides) {
      lines.push(`    --label "${r.from}=${r.to}"      (${r.occurrences} step(s) agree)`);
    }
    lines.push('');
    lines.push('  Nothing has been changed. Apply it as a reviewed patch:');
    lines.push(`    npx tsx src/cli.ts repair -c ${report.capabilityId} -t ${report.tenantId}`);
  }

  lines.push('');
  return lines.join('\n');
}
