/**
 * Drift analysis and repair-patch validation.
 *
 * These are unit tests rather than integration tests because both modules are
 * pure: drift analysis is (capability, result) -> report, and patch validation
 * is (capability, renames) -> capability | problems. Keeping the judgement in
 * pure functions is what lets the interesting cases — the ones that would need
 * a re-worded application to reproduce end to end — be tested in milliseconds.
 *
 * The cases that matter here are the refusals. Anyone can write a repair tool
 * that repairs; the value is in the things it declines to touch.
 */

import { describe, expect, it } from 'vitest';
import { analyzeRun, inferRename, proposeRenames, type DriftFinding } from '../src/replay/drift.js';
import { applyRenames, isRepairable, type ProposedRename } from '../src/repair/propose.js';
import { referenceCapability } from './fixtures/reference-capability.js';
import type { ReplayResult, TraceEntry } from '../src/types/result.js';

const BASE_URL = 'http://localhost:4300/t/northstar';
const cap = referenceCapability(BASE_URL);
/** s05 is the member-id text box: it declares a label AND a container, which is
 *  what the vocabulary/structural distinction is tested against. */
const stepId = cap.steps[4]!.id;

function meta() {
  return {
    runId: 'test-run',
    capabilityId: cap.id,
    capabilityVersion: cap.version,
    tenantId: cap.surface.recordedOnTenant,
    mode: 'replay' as const,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 10,
    stepsAttempted: 1,
    evidenceDir: '/tmp',
    llmCalls: 0,
    inputs: {},
  };
}

function traceEntry(over: Partial<TraceEntry> = {}): TraceEntry {
  return {
    stepId,
    intent: 'do the thing',
    action: 'click',
    risk: 'safe',
    startedAt: new Date().toISOString(),
    durationMs: 5,
    status: 'ok',
    ...over,
  };
}

function successWith(trace: TraceEntry[]): ReplayResult {
  return { status: 'success', meta: meta(), outputs: {}, trace, evidence: [] };
}

function failureWith(over: Partial<ReplayResult & { failure: unknown }>): ReplayResult {
  return {
    status: 'failure',
    meta: meta(),
    failure: {
      kind: 'target_not_found',
      message: 'no match',
      atStepId: stepId,
      stepIntent: 'do the thing',
      expected: null,
      observed: null,
      remediation: null,
      ...((over as { failure?: Record<string, unknown> }).failure ?? {}),
    },
    partialOutputs: {},
    trace: [],
    evidence: [],
  } as ReplayResult;
}

describe('drift analysis', () => {
  it('reports stable when every declared signal matched', () => {
    const report = analyzeRun(
      cap,
      successWith([
        traceEntry({
          resolution: {
            score: 90,
            runnerUpScore: 20,
            matchedSignals: ['role', 'label'],
            missedSignals: [],
            candidateCount: 3,
          },
        }),
      ]),
    );

    expect(report.status).toBe('stable');
    expect(report.findings).toHaveLength(0);
  });

  it('reports degraded — not broken — when a signal is lost but the run completes', () => {
    // This is the state the report exists to catch: nothing failed, and the
    // capability is one more rename away from an outage.
    const declared = cap.steps[4]!.act as { target: { label?: string } };

    const report = analyzeRun(
      cap,
      successWith([
        traceEntry({
          resolution: {
            score: 55,
            runnerUpScore: 20,
            matchedSignals: ['role'],
            missedSignals: ['label'],
            candidateCount: 2,
            observed: { role: 'textbox', label: 'Member Number', name: '' },
          },
        }),
      ]),
    );

    expect(report.status).toBe('degraded');
    expect(report.findings[0]).toMatchObject({
      kind: 'vocabulary',
      signal: 'label',
      expected: declared.target.label,
      observed: 'Member Number',
      survived: true,
    });
  });

  it('separates structural drift from vocabulary drift', () => {
    const report = analyzeRun(
      cap,
      successWith([
        traceEntry({
          resolution: {
            score: 60,
            runnerUpScore: null,
            matchedSignals: ['role', 'label'],
            missedSignals: ['container'],
            candidateCount: 1,
            observed: { role: 'textbox', label: 'Member ID', name: '', container: 'Member Lookup' },
          },
        }),
      ]),
    );

    expect(report.findings[0]?.kind).toBe('structural');
    // and it must not become a rename proposal — a renamed panel is a layout
    // change for a human, not a vocabulary delta a binding can absorb.
    expect(report.suggestedLabelOverrides).toHaveLength(0);
  });

  it('classifies a failed checkpoint as checkpoint drift', () => {
    const report = analyzeRun(
      cap,
      failureWith({
        failure: { kind: 'checkpoint_failed', expected: 'text "Member Search" present on screen' },
      } as never),
    );

    expect(report.status).toBe('broken');
    expect(report.findings[0]?.kind).toBe('checkpoint');
    expect(isRepairable(report.findings[0]!)).toBe(false);
  });
});

describe('rename inference', () => {
  const declared = { role: 'textbox', label: 'Member ID' };

  it('reads a rename off the candidates when only one shares a word and the role', () => {
    expect(
      inferRename(declared, [
        { role: 'textbox', label: 'Member Number' },
        { role: 'textbox', label: 'Last Name' },
        { role: 'button', label: 'Find Member' },
      ]),
    ).toEqual({ from: 'Member ID', to: 'Member Number' });
  });

  it('refuses when two candidates are equally plausible', () => {
    // Guessing here would rewrite an artifact to point at the wrong field of a
    // banking record. Ambiguity must stay ambiguous.
    expect(
      inferRename(declared, [
        { role: 'textbox', label: 'Member Number' },
        { role: 'textbox', label: 'Member Name' },
      ]),
    ).toBeUndefined();
  });

  it('refuses a candidate that shares no word with the declared label', () => {
    expect(inferRename(declared, [{ role: 'textbox', label: 'Last Name' }])).toBeUndefined();
  });

  it('refuses a candidate of a different role', () => {
    expect(inferRename(declared, [{ role: 'button', label: 'Member Number' }])).toBeUndefined();
  });

  it('only proposes renames it can see both sides of', () => {
    const findings: DriftFinding[] = [
      { stepId: 's1', intent: '', kind: 'vocabulary', signal: 'label', expected: 'Member ID', survived: true },
    ];
    expect(proposeRenames(findings)).toHaveLength(0);
  });

  it('counts agreement across steps', () => {
    const f = (stepId: string): DriftFinding => ({
      stepId,
      intent: '',
      kind: 'vocabulary',
      signal: 'label',
      expected: 'Member ID',
      observed: 'Member Number',
      survived: true,
    });
    expect(proposeRenames([f('s1'), f('s2')])[0]).toMatchObject({ occurrences: 2 });
  });
});

describe('repair patches', () => {
  const rename = (over: Partial<ProposedRename> = {}): ProposedRename => ({
    from: 'Member ID',
    to: 'Member Number',
    occurrences: 1,
    source: 'analysis',
    reason: 'test',
    ...over,
  });

  const patchMeta = { nextVersion: cap.version + 1, runId: 'test-run', model: null };

  it('applies a label override as a new draft version', () => {
    const tenantId = cap.surface.recordedOnTenant;
    const result = applyRenames(cap, tenantId, [rename()], patchMeta);

    expect(result.ok).toBe(true);
    expect(result.capability?.version).toBe(cap.version + 1);
    expect(result.capability?.governance.approval).toBe('draft');
    expect(
      result.capability?.tenants.find((t) => t.tenantId === tenantId)?.labelOverrides['Member ID'],
    ).toBe('Member Number');
  });

  it('strips the previous reviewer — approval does not survive a patch', () => {
    const approved = referenceCapability(BASE_URL);
    approved.governance.approval = 'approved';
    approved.governance.reviewedBy = 'someone.else';

    const result = applyRenames(approved, approved.surface.recordedOnTenant, [rename()], patchMeta);
    expect(result.capability?.governance.reviewedBy).toBeUndefined();
  });

  it('leaves steps, checkpoints, outcomes and policy byte-identical', () => {
    const result = applyRenames(cap, cap.surface.recordedOnTenant, [rename()], patchMeta);
    const patched = result.capability!;

    expect(patched.steps).toEqual(cap.steps);
    expect(patched.successCheckpoint).toEqual(cap.successCheckpoint);
    expect(patched.outcomes).toEqual(cap.outcomes);
    expect(patched.policy).toEqual(cap.policy);
    expect(patched.inputs).toEqual(cap.inputs);
    expect(patched.outputs).toEqual(cap.outputs);
  });

  it('refuses to silently rebind a label the tenant already overrides', () => {
    const bound = referenceCapability(BASE_URL);
    const tenantId = bound.surface.recordedOnTenant;
    bound.tenants.find((t) => t.tenantId === tenantId)!.labelOverrides['Member ID'] = 'Existing Wording';

    const result = applyRenames(bound, tenantId, [rename()], patchMeta);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/already bound/i);
  });

  it('refuses an unknown tenant', () => {
    const result = applyRenames(cap, 'not-a-tenant', [rename()], patchMeta);
    expect(result.ok).toBe(false);
  });

  it('refuses an empty patch rather than writing a pointless version', () => {
    expect(applyRenames(cap, cap.surface.recordedOnTenant, [], patchMeta).ok).toBe(false);
  });

  it('re-hashes so the content hash still describes the artifact', () => {
    const result = applyRenames(cap, cap.surface.recordedOnTenant, [rename()], patchMeta);
    expect(result.capability?.provenance.contentHash).not.toBe(cap.provenance.contentHash);
  });
});
