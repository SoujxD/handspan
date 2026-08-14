/**
 * Contract tests: schema invariants, condition evaluation, extraction, and the
 * control-transfer state machine.
 *
 * The schema-invariant tests are the ones worth reading. They assert that a
 * hand-edited artifact cannot ship a step that double-commits, a credential
 * baked in as a literal, or a state change nobody verified — the three ways a
 * plausible-looking artifact quietly becomes dangerous in production.
 */

import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, highestRisk, parseCapability, validateCapability, type Capability } from '../src/types/artifact.js';
import { evaluateCondition, extract } from '../src/replay/evaluate.js';
import { exitCodeFor, type ReplayResult } from '../src/types/result.js';
import { SessionLease, ControlDeniedError } from '../src/control/lease.js';
import type { SurfaceSnapshot, UiNode } from '../src/types/surface.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function baseCapability(over: Partial<Capability> = {}): Capability {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'test_cap',
    version: 1,
    name: 'Test',
    description: 'test',
    surface: {
      kind: 'legacy_web',
      product: 'meridian-core',
      recordedOnTenant: 'northstar',
      entryUrl: '{{baseUrl}}/login',
    },
    inputs: [{ name: 'memberId', type: 'string', description: 'id', required: true, sensitivity: 'internal' }],
    outputs: [],
    steps: [
      {
        id: 's01',
        intent: 'search',
        act: {
          action: 'type',
          target: { description: 'member box', role: 'textbox', label: 'Member ID', nameMatch: 'normalized', labelMatch: 'normalized', framePath: [], hints: {} },
          value: { from: 'param', name: 'memberId' },
          clearFirst: true,
        },
        risk: 'safe',
        retry: { attempts: 1, backoffMs: 750 },
      },
    ],
    successCheckpoint: { kind: 'textPresent', text: 'Member Record', caseSensitive: false },
    outcomes: [],
    tenants: [
      {
        tenantId: 'northstar',
        displayName: 'Northstar',
        baseUrl: 'http://localhost:4300/t/northstar',
        labelOverrides: {},
        additionalOutcomes: [],
        overrides: {},
        verification: { lastResult: 'unverified' },
      },
    ],
    policy: { maxRisk: 'safe', requiresConfirmation: false, allowedOrigins: [] },
    governance: { approval: 'draft', stability: { runs: 0, successes: 0 } },
    provenance: { discoveredAt: '2026-01-01T00:00:00Z', model: 'test', discoveryRunId: 'r1', generator: 'handspan' },
    ...over,
  };
}

function snap(over: Partial<SurfaceSnapshot> = {}): SurfaceSnapshot {
  return {
    capturedAt: '2026-01-01T00:00:00Z',
    url: 'http://localhost:4300/t/northstar/member/12345',
    title: 'Member 12345',
    nodes: [],
    text: 'Member Record — 12345 Status ACTIVE',
    ...over,
  };
}

function cell(p: Partial<UiNode>): UiNode {
  return {
    handle: 'c', role: 'cell', name: '', label: '', labelSource: 'table-cell',
    framePath: [], ordinal: 0, visible: true, enabled: true, hints: {}, ...p,
  };
}

// ---------------------------------------------------------------------------

describe('capability invariants', () => {
  it('accepts a well-formed capability', () => {
    expect(() => parseCapability(baseCapability())).not.toThrow();
  });

  it('rejects a state-changing step with no checkpoint', () => {
    // "Assume the click worked" is the failure mode the brief calls out.
    const cap = baseCapability({
      steps: [
        {
          id: 's01', intent: 'submit',
          act: { action: 'click', target: { description: 'Submit', role: 'button', name: 'Submit', nameMatch: 'normalized', labelMatch: 'normalized', framePath: [], hints: {} } },
          risk: 'safe', retry: { attempts: 1, backoffMs: 750 },
        },
      ],
    });
    expect(validateCapability(cap).some((p) => /no checkpoint/.test(p))).toBe(true);
  });

  it('rejects a retry on an irreversible step', () => {
    // Retrying something that may already have committed is how you
    // double-post a transaction.
    const cap = baseCapability({
      steps: [
        {
          id: 's01', intent: 'confirm transfer',
          act: { action: 'click', target: { description: 'Confirm', role: 'button', name: 'Confirm', nameMatch: 'normalized', labelMatch: 'normalized', framePath: [], hints: {} } },
          risk: 'irreversible',
          checkpoint: { kind: 'textPresent', text: 'Done', caseSensitive: false },
          retry: { attempts: 3, backoffMs: 500 },
        },
      ],
      policy: { maxRisk: 'irreversible', requiresConfirmation: true, allowedOrigins: [] },
    });
    expect(validateCapability(cap).some((p) => /must not auto-retry/.test(p))).toBe(true);
  });

  it('rejects a literal that looks like a credential', () => {
    const cap = baseCapability({
      steps: [
        {
          id: 's01', intent: 'sign in',
          act: {
            action: 'type',
            target: { description: 'pwd', role: 'textbox', label: 'Password', nameMatch: 'normalized', labelMatch: 'normalized', framePath: [], hints: {} },
            value: { from: 'literal', value: 'sk-ant-api03-abcdefghijklmnop' },
            clearFirst: true,
          },
          risk: 'sensitive', retry: { attempts: 1, backoffMs: 750 },
        },
      ],
      policy: { maxRisk: 'sensitive', requiresConfirmation: false, allowedOrigins: [] },
    });
    expect(validateCapability(cap).some((p) => /credential/.test(p))).toBe(true);
  });

  it('rejects a step referencing an undeclared input parameter', () => {
    const cap = baseCapability({ inputs: [] });
    expect(validateCapability(cap).some((p) => /undeclared input/.test(p))).toBe(true);
  });

  it('rejects a secret declared as an output', () => {
    // Returning a secret to a caller persists it, which defeats the point.
    const cap = baseCapability({
      outputs: [
        {
          name: 'token', type: 'string', description: 'x', sensitivity: 'secret',
          extraction: { via: 'regexOnPageText', pattern: '(.*)', group: 1 },
          transform: 'trim', required: true,
        },
      ],
    });
    expect(validateCapability(cap).some((p) => /must not be returned/.test(p))).toBe(true);
  });

  it('rejects a recoverable outcome with no recovery action', () => {
    const cap = baseCapability({
      outcomes: [
        { code: 'notice', title: 'Notice', classification: 'recoverable', detect: { kind: 'textPresent', text: 'Notice', caseSensitive: false }, scope: 'global', extract: [] },
      ],
    });
    expect(validateCapability(cap).some((p) => /declares no recovery/.test(p))).toBe(true);
  });

  it('rejects a declared maxRisk that disagrees with the steps', () => {
    const cap = baseCapability({ policy: { maxRisk: 'irreversible', requiresConfirmation: true, allowedOrigins: [] } });
    expect(validateCapability(cap).some((p) => /maxRisk/.test(p))).toBe(true);
  });

  it('orders risk correctly', () => {
    expect(highestRisk(['safe', 'confirmable', 'sensitive'])).toBe('confirmable');
    expect(highestRisk(['safe'])).toBe('safe');
  });
});

describe('conditions', () => {
  it('matches a URL pattern', () => {
    expect(evaluateCondition({ kind: 'urlMatches', pattern: '/member/[^/]+$' }, { snapshot: snap(), resolveOptions: {} })).toBe(true);
  });

  it('is whitespace-insensitive for text presence', () => {
    const s = snap({ text: 'Confirmation   Number\n\nMC-4101' });
    expect(evaluateCondition({ kind: 'textPresent', text: 'Confirmation Number', caseSensitive: false }, { snapshot: s, resolveOptions: {} })).toBe(true);
  });

  it('composes with all/any/not', () => {
    const ctx = { snapshot: snap(), resolveOptions: {} };
    expect(evaluateCondition({ kind: 'all', of: [{ kind: 'textPresent', text: 'Member Record', caseSensitive: false }, { kind: 'urlMatches', pattern: '/member/' }] }, ctx)).toBe(true);
    expect(evaluateCondition({ kind: 'not', of: { kind: 'textPresent', text: 'nope', caseSensitive: false } }, ctx)).toBe(true);
  });

  it('fails closed on a malformed regex instead of throwing', () => {
    // A bad pattern in an artifact must surface as a checkpoint failure with
    // evidence, not as a stack trace that loses the run.
    expect(evaluateCondition({ kind: 'regexPresent', pattern: '([unclosed' }, { snapshot: snap(), resolveOptions: {} })).toBe(false);
  });
});

describe('extraction', () => {
  const gridSnapshot = snap({
    nodes: [
      cell({ handle: 'c1', value: '000123450001', rowKey: '000123450001', columnHeader: 'Account', label: 'Account' }),
      cell({ handle: 'c2', value: 'SAVINGS', rowKey: '000123450001', columnHeader: 'Type', label: 'Type' }),
      cell({ handle: 'c3', value: '$18,432.07', rowKey: '000123450001', columnHeader: 'Current Balance', label: 'Current Balance' }),
      cell({ handle: 'c4', value: '000123450002', rowKey: '000123450002', columnHeader: 'Account', label: 'Account' }),
      cell({ handle: 'c5', value: 'CHECKING', rowKey: '000123450002', columnHeader: 'Type', label: 'Type' }),
      cell({ handle: 'c6', value: '$2,319.44', rowKey: '000123450002', columnHeader: 'Current Balance', label: 'Current Balance' }),
    ],
  });

  it('reads the right row from a data grid', () => {
    // The test that justifies fromTableCell existing: a column-only lookup
    // would return the checking balance half the time.
    const r = extract(
      {
        name: 'savingsBalance', type: 'money', description: '', sensitivity: 'internal',
        extraction: { via: 'fromTableCell', rowMatch: 'SAVINGS', columnLabel: 'Current Balance', matchMode: 'contains', framePath: [] },
        transform: 'stripCurrency', required: true,
      },
      { snapshot: gridSnapshot, resolveOptions: {} },
    );
    expect(r.ok).toBe(true);
    expect(r.value).toBe(18432.07);
  });

  it('reads a different row without ambiguity', () => {
    const r = extract(
      {
        name: 'checkingBalance', type: 'money', description: '', sensitivity: 'internal',
        extraction: { via: 'fromTableCell', rowMatch: 'CHECKING', columnLabel: 'Current Balance', matchMode: 'contains', framePath: [] },
        transform: 'stripCurrency', required: true,
      },
      { snapshot: gridSnapshot, resolveOptions: {} },
    );
    expect(r.value).toBe(2319.44);
  });

  it('reads a labelled cell on a form-style screen', () => {
    const s = snap({ nodes: [cell({ handle: 'c1', label: 'Status', value: 'ACTIVE' })] });
    const r = extract(
      {
        name: 'status', type: 'string', description: '', sensitivity: 'internal',
        extraction: { via: 'fromLabelledCell', label: 'Status', labelMatch: 'normalized', framePath: [], direction: 'right' },
        transform: 'trim', required: true,
      },
      { snapshot: s, resolveOptions: {} },
    );
    expect(r.value).toBe('ACTIVE');
  });

  it('reports a miss rather than returning an empty value', () => {
    const r = extract(
      {
        name: 'missing', type: 'string', description: '', sensitivity: 'internal',
        extraction: { via: 'fromTableCell', rowMatch: 'NOPE', columnLabel: 'Current Balance', matchMode: 'contains', framePath: [] },
        transform: 'trim', required: true,
      },
      { snapshot: gridSnapshot, resolveOptions: {} },
    );
    expect(r.ok).toBe(false);
    expect(r.problem).toContain('NOPE');
  });
});

describe('result contract', () => {
  const meta = {
    runId: 'r', capabilityId: 'c', capabilityVersion: 1, tenantId: 't',
    mode: 'replay' as const, startedAt: '', finishedAt: '', durationMs: 0,
    stepsAttempted: 1, evidenceDir: '', llmCalls: 0,
  };

  it('exits 0 for a business outcome — it is an answer, not a failure', () => {
    // A scheduler that retries on non-zero must not retry "no such member".
    const r: ReplayResult = {
      status: 'outcome', meta, outcome: 'member_not_found', outcomeTitle: 'No member found',
      classification: 'business', details: {}, atStepId: 's02', trace: [], evidence: [],
    };
    expect(exitCodeFor(r)).toBe(0);
  });

  it('exits non-zero for a hard failure', () => {
    const r: ReplayResult = {
      status: 'failure', meta,
      failure: { kind: 'checkpoint_failed', message: 'x', atStepId: 's1', stepIntent: 'i', expected: 'e', observed: 'o', remediation: 'r' },
      partialOutputs: {}, trace: [], evidence: [],
    };
    expect(exitCodeFor(r)).toBe(1);
  });

  it('exits with a distinct code for an escalation — parked, not lost', () => {
    const r: ReplayResult = {
      status: 'escalated', meta, interventionId: 'INT-1', reason: 'x', guidance: 'y',
      atStepId: 's1', operatorUrl: 'http://localhost:4400/i/INT-1', trace: [], evidence: [],
    };
    expect(exitCodeFor(r)).toBe(75);
  });
});

describe('session lease (control transfer)', () => {
  it('starts held by the automation', () => {
    const l = new SessionLease('s1');
    expect(l.holder).toBe('automation');
    expect(() => l.assertHeldBy('automation')).not.toThrow();
  });

  it('has a state where nobody holds control', () => {
    // Without this, a handoff has a window where both sides think they drive.
    const l = new SessionLease('s1');
    l.pause('stuck', 'INT-1');
    expect(l.holder).toBe('nobody');
    expect(() => l.assertHeldBy('automation')).toThrow(ControlDeniedError);
    expect(() => l.assertHeldBy('operator')).toThrow(ControlDeniedError);
  });

  it('blocks the automation while an operator holds control', () => {
    const l = new SessionLease('s1');
    l.pause('stuck', 'INT-1');
    l.grantToOperator('op@local');
    expect(l.holder).toBe('operator');
    expect(() => l.assertHeldBy('automation')).toThrow(ControlDeniedError);
  });

  it('refuses to grant control from a state that is not paused', () => {
    const l = new SessionLease('s1');
    expect(() => l.grantToOperator('op@local')).toThrow();
  });

  it('refuses to resume directly from operator control', () => {
    // The operator must hand back explicitly; the automation cannot snatch it.
    const l = new SessionLease('s1');
    l.pause('stuck', 'INT-1');
    l.grantToOperator('op@local');
    expect(() => l.resume('done')).toThrow();
  });

  it('completes a full handoff cycle and records it', () => {
    const l = new SessionLease('s1');
    l.pause('needs a human', 'INT-1');
    l.grantToOperator('op@local');
    l.handBack('did it manually');
    expect(l.holder).toBe('nobody');
    l.resume('operator finished');
    expect(l.holder).toBe('automation');

    const transitions = l.history.map((e) => `${e.from}->${e.to}`);
    expect(transitions).toEqual([
      'nobody->automation',
      'automation->nobody',
      'nobody->operator',
      'operator->nobody',
      'nobody->automation',
    ]);
  });
});
