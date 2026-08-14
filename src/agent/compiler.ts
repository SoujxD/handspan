/**
 * Trace -> capability compiler.
 *
 * The model proposes; the compiler disposes. Everything the model returns is
 * treated as a *proposal* that has to survive a set of structural rules before
 * it becomes an artifact:
 *
 *   - Targets are re-derived from the observed node with `describeNode`, which
 *     only emits semantic signals. Even if the model wanted to pin an id, it
 *     could not — the id lands in `hints`, which the resolver weights at ~2.
 *   - Every state-changing step gets a checkpoint, synthesised from the
 *     observed before/after state if the model did not supply one. A step that
 *     cannot be verified does not ship.
 *   - Values bound to parameters become parameter references; the literal is
 *     dropped. Sensitive and secret values are dropped unconditionally.
 *   - Risk is re-classified from policy, not taken from the trace.
 *
 * Then `parseCapability` runs the invariants in artifact.ts. If the compiler
 * emits something invalid, discovery fails loudly rather than writing a
 * plausible-looking artifact that misbehaves in production three weeks later.
 */

import { createHash } from 'node:crypto';
import type {
  Capability,
  Condition,
  ElementDescriptor,
  InputParam,
  OutcomeRule,
  OutputField,
  RiskClass,
  Step,
  StepAction,
} from '../types/artifact.js';
import { SCHEMA_VERSION, highestRisk, parseCapability } from '../types/artifact.js';
import { describeNode } from '../surface/web/resolver.js';
import type { PolicyEngine } from '../safety/policy.js';
import type { DiscoveryAction, DiscoveryTrace } from './loop.js';

export interface CompileOptions {
  policy: PolicyEngine;
  /** Institution the run happened against. */
  tenantId: string;
  tenantDisplayName: string;
  /** Origin + institution path prefix. Everything after it is product-generic. */
  baseUrl: string;
  vendorProduct: string;
  vendorVersion?: string;
  model: string;
  effort: string;
  discoveryRunId: string;
}

export function compile(trace: DiscoveryTrace, opts: CompileOptions): Capability {
  const finish = trace.finish;
  if (!finish) {
    throw new Error(
      `Discovery did not finish (stopped because: ${trace.stoppedBecause}). No artifact was written.`,
    );
  }

  const capabilityId = String(finish['capabilityId'] ?? 'unnamed_capability')
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '_');

  const inputs = buildInputs(finish, trace);
  const paramByValue = buildParamValueIndex(trace, inputs);
  const outputs = buildOutputs(finish);

  const steps = buildSteps(trace, opts, inputs, paramByValue);
  const outcomes = buildOutcomes(finish);
  const successCheckpoint = buildSuccessCheckpoint(finish, trace, opts.baseUrl);

  const maxRisk: RiskClass = highestRisk(steps.map((s) => s.risk));

  const capability: Capability = {
    schemaVersion: SCHEMA_VERSION,
    id: capabilityId,
    version: 1,
    name: String(finish['name'] ?? capabilityId),
    description: String(finish['description'] ?? ''),

    surface: {
      kind: 'legacy_web',
      product: opts.vendorProduct,
      productVersion: opts.vendorVersion,
      recordedOnTenant: opts.tenantId,
      entryUrl: templatize(trace.entryUrl, opts.baseUrl),
    },

    inputs,
    outputs,
    steps,
    successCheckpoint,
    outcomes,

    tenants: [
      {
        tenantId: opts.tenantId,
        displayName: opts.tenantDisplayName,
        baseUrl: opts.baseUrl,
        productVersion: opts.vendorVersion,
        labelOverrides: {},
        additionalOutcomes: [],
        overrides: {},
        verification: { lastResult: 'unverified' },
      },
    ],

    policy: {
      maxRisk,
      requiresConfirmation: steps.some((s) => s.risk === 'confirmable' || s.risk === 'irreversible'),
      allowedOrigins: opts.policy.allowedOrigins,
    },

    governance: {
      // Never auto-approve. A freshly-discovered capability is a draft until a
      // person reads it; that gate is most of the value of making it reviewable.
      approval: 'draft',
      stability: { runs: 0, successes: 0 },
    },

    provenance: {
      discoveredAt: new Date().toISOString(),
      model: opts.model,
      effort: opts.effort,
      discoveryRunId: opts.discoveryRunId,
      generator: 'handspan',
    },
  };

  capability.provenance.contentHash = hashCapability(capability);
  return parseCapability(capability);
}

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

function buildInputs(finish: Record<string, unknown>, trace: DiscoveryTrace): InputParam[] {
  const declared = Array.isArray(finish['inputs']) ? (finish['inputs'] as Record<string, unknown>[]) : [];
  const inputs: InputParam[] = declared.map((d) => ({
    name: String(d['name'] ?? 'param'),
    type: (asEnum(d['type'], ['string', 'number', 'boolean', 'money', 'enum']) ?? 'string') as InputParam['type'],
    description: String(d['description'] ?? ''),
    required: d['required'] !== false,
    sensitivity: (asEnum(d['sensitivity'], ['public', 'internal', 'pii', 'secret']) ??
      'internal') as InputParam['sensitivity'],
    enumValues: Array.isArray(d['enumValues']) ? (d['enumValues'] as string[]) : undefined,
    example: d['example'] === undefined ? undefined : String(d['example']),
  }));

  // A parameter the model bound during the run but forgot to declare would
  // produce an artifact that fails validation. Backfill it rather than losing
  // the binding — and mark it so a reviewer can see it was inferred.
  const names = new Set(inputs.map((i) => i.name));
  for (const a of trace.actions) {
    if (a.parameterName && !names.has(a.parameterName)) {
      names.add(a.parameterName);
      inputs.push({
        name: a.parameterName,
        type: 'string',
        description: `(inferred during compilation) Value for "${a.node?.label || a.node?.name || a.intent}".`,
        required: true,
        sensitivity: a.risk === 'sensitive' ? 'secret' : 'internal',
      });
    }
  }

  return inputs;
}

/** literal value -> parameter name, so typed literals can be swapped for refs. */
function buildParamValueIndex(trace: DiscoveryTrace, inputs: InputParam[]): Map<string, string> {
  const byValue = new Map<string, string>();
  const known = new Set(inputs.map((i) => i.name));
  for (const a of trace.actions) {
    if (a.parameterName && a.value && known.has(a.parameterName)) {
      byValue.set(a.value, a.parameterName);
    }
  }
  return byValue;
}

function buildOutputs(finish: Record<string, unknown>): OutputField[] {
  const declared = Array.isArray(finish['outputs']) ? (finish['outputs'] as Record<string, unknown>[]) : [];

  return declared.map((d): OutputField => {
    const kind = String(d['extractionKind'] ?? 'regexOnPageText');
    const name = String(d['name'] ?? 'value');

    let extraction: OutputField['extraction'];
    switch (kind) {
      case 'fromLabelledCell':
        extraction = {
          via: 'fromLabelledCell',
          label: String(d['label'] ?? name),
          labelMatch: 'normalized',
          framePath: [],
          direction: (asEnum(d['direction'], ['right', 'below']) ?? 'right') as 'right' | 'below',
        };
        break;
      case 'fromTableCell':
        extraction = {
          via: 'fromTableCell',
          rowMatch: String(d['rowMatch'] ?? ''),
          columnLabel: String(d['columnLabel'] ?? d['label'] ?? name),
          matchMode: 'contains',
          framePath: [],
        };
        break;
      case 'urlCapture':
        extraction = { via: 'urlCapture', pattern: String(d['pattern'] ?? '(.*)'), group: 1 };
        break;
      case 'elementText':
        // The model gave a handle, which is snapshot-scoped and meaningless at
        // replay time. Degrade to a label-relative read, which is durable.
        extraction = {
          via: 'fromLabelledCell',
          label: String(d['label'] ?? name),
          labelMatch: 'normalized',
          framePath: [],
          direction: 'right',
        };
        break;
      default:
        extraction = { via: 'regexOnPageText', pattern: String(d['pattern'] ?? `${escapeRe(name)}\\s*(.+)`), group: 1 };
    }

    return {
      name,
      type: (asEnum(d['type'], ['string', 'number', 'boolean', 'money', 'enum']) ?? 'string') as OutputField['type'],
      description: String(d['description'] ?? ''),
      sensitivity: (asEnum(d['sensitivity'], ['public', 'internal', 'pii', 'secret']) ??
        'internal') as OutputField['sensitivity'],
      extraction,
      transform: (asEnum(d['transform'], ['none', 'trim', 'stripCurrency', 'digitsOnly']) ??
        'trim') as OutputField['transform'],
      required: true,
    };
  });
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function buildSteps(
  trace: DiscoveryTrace,
  opts: CompileOptions,
  inputs: InputParam[],
  paramByValue: Map<string, string>,
): Step[] {
  const steps: Step[] = [];
  const sensitiveParams = new Set(
    inputs.filter((i) => i.sensitivity === 'secret' || i.sensitivity === 'pii').map((i) => i.name),
  );

  let n = 0;
  for (let i = 0; i < trace.actions.length; i++) {
    const a = trace.actions[i]!;
    // A denied or failed action is history, not a step.
    if (a.denied) continue;

    const act = toStepAction(a, opts, paramByValue, sensitiveParams);
    if (!act) continue;

    const id = `s${String(++n).padStart(2, '0')}`;
    const risk = opts.policy.classify({
      kind: toPolicyKind(a.tool),
      url: a.navigateUrl,
      targetName: a.node?.name || a.node?.label,
      targetContainer: a.node?.container,
      fieldLabel: a.node?.label,
    });

    const prevText = i > 0 ? (trace.actions[i - 1]?.after?.textExcerpt ?? '') : '';
    const checkpoint = synthesiseCheckpoint(a, prevText, opts.baseUrl, paramByValue);

    const step: Step = {
      id,
      intent: a.intent,
      act,
      risk,
      checkpoint,
      // Retry is only ever attached to steps that cannot double-commit; see the
      // invariant in artifact.ts. `type`/`select` are idempotent, so they get a
      // small budget to ride out a slow render.
      retry:
        risk === 'safe' && (act.action === 'type' || act.action === 'select')
          ? { attempts: 2, backoffMs: 500 }
          : { attempts: 1, backoffMs: 750 },
    };
    steps.push(step);
  }

  return steps;
}

function toStepAction(
  a: DiscoveryAction,
  opts: CompileOptions,
  paramByValue: Map<string, string>,
  sensitiveParams: Set<string>,
): StepAction | null {
  switch (a.tool) {
    case 'navigate':
      return { action: 'navigate', url: templatize(a.navigateUrl ?? a.url, opts.baseUrl) };

    case 'click':
      if (!a.node) return null;
      return { action: 'click', target: describe(a) };

    case 'type_text': {
      if (!a.node) return null;
      return {
        action: 'type',
        target: describe(a),
        value: valueSource(a, paramByValue, sensitiveParams),
        clearFirst: true,
      };
    }

    case 'select_option': {
      if (!a.node) return null;
      return { action: 'select', target: describe(a), value: valueSource(a, paramByValue, sensitiveParams) };
    }

    default:
      return null;
  }
}

function describe(a: DiscoveryAction): ElementDescriptor {
  return describeNode(a.node!, a.siblings ?? []);
}

/**
 * Choose between a parameter reference and a literal.
 *
 * The bias is strongly toward parameterising: a literal only survives when the
 * model did not bind it AND it does not look like something a caller would
 * vary. Anything sensitive is never stored as a literal under any circumstance.
 */
function valueSource(
  a: DiscoveryAction,
  paramByValue: Map<string, string>,
  sensitiveParams: Set<string>,
): { from: 'param'; name: string } | { from: 'literal'; value: string } | { from: 'secret'; ref: string } {
  const explicit = a.parameterName;
  const inferred = a.value ? paramByValue.get(a.value) : undefined;
  const param = explicit ?? inferred;

  if (param) {
    return sensitiveParams.has(param) ? { from: 'secret', ref: param } : { from: 'param', name: param };
  }
  // Unbound but the field is sensitive: refuse to persist the value at all and
  // synthesise a secret reference the caller must satisfy.
  if (a.risk === 'sensitive') {
    return { from: 'secret', ref: slugParam(a.node?.label || a.node?.name || 'credential') };
  }
  return { from: 'literal', value: a.value ?? '' };
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/**
 * Synthesise a post-condition from what was actually observed.
 *
 * URL change is the strongest signal and the first choice. When the URL does
 * not change — a WebForms postback that re-renders the same route — fall back
 * to text that appeared *after* the action and was not present before, which
 * is the same evidence a human uses to decide a click worked.
 */
function synthesiseCheckpoint(
  a: DiscoveryAction,
  previousText: string,
  baseUrl: string,
  paramByValue: Map<string, string>,
): Condition | undefined {
  if (!a.after) return undefined;

  const conditions: Condition[] = [];

  const urlChanged = a.after.url !== a.url;
  if (urlChanged) {
    conditions.push({ kind: 'urlMatches', pattern: urlPattern(a.after.url, baseUrl, paramByValue) });
  }

  const novel = firstNovelPhrase(a.after.textExcerpt, previousText);
  if (novel) {
    conditions.push({ kind: 'textPresent', text: novel, caseSensitive: false });
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0]!;
  return { kind: 'all', of: conditions };
}

/**
 * Text present after the action that was not present before.
 *
 * Values are excluded on purpose: "$18,432.07" is novel every time and would
 * make the checkpoint fail for a different member. We want the *label* that
 * marks the screen ("Confirmation Number"), not the datum on it.
 */
function firstNovelPhrase(after: string, before: string): string | undefined {
  const beforeNorm = before.toLowerCase();
  const candidates = after
    .split(/[\n\r]+|(?<=\.)\s+|\s{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 55)
    .filter((s) => !/\d{3,}/.test(s)) // reject id- and amount-like strings
    .filter((s) => !/[$£€]/.test(s))
    .filter((s) => !beforeNorm.includes(s.toLowerCase()));

  return candidates[0];
}

/**
 * Build a URL regex that is tenant-agnostic and value-agnostic.
 *
 * Everything before the tenant base URL is dropped, and any path segment equal
 * to a captured parameter value becomes a wildcard — so a checkpoint recorded
 * while looking at member 12345 passes for member 20881, and passes at a
 * different institution.
 */
function urlPattern(url: string, baseUrl: string, paramByValue: Map<string, string>): string {
  let path = url.startsWith(baseUrl) ? url.slice(baseUrl.length) : new URL(url).pathname;
  if (!path.startsWith('/')) path = `/${path}`;

  const segments = path.split('?')[0]!.split('/');
  const rebuilt = segments.map((seg) => (paramByValue.has(seg) ? '[^/]+' : escapeRe(seg)));
  return `${rebuilt.join('/')}(?:[?#].*)?$`;
}

function buildSuccessCheckpoint(
  finish: Record<string, unknown>,
  trace: DiscoveryTrace,
  baseUrl: string,
): Condition {
  const raw = finish['successCheckpoint'] as Record<string, unknown> | undefined;
  const kind = String(raw?.['kind'] ?? '');
  const value = String(raw?.['value'] ?? '');

  if (value) {
    if (kind === 'urlMatches') return { kind: 'urlMatches', pattern: value };
    if (kind === 'regexPresent') return { kind: 'regexPresent', pattern: value };
    return { kind: 'textPresent', text: value, caseSensitive: false };
  }

  // The model must supply this, but a missing checkpoint should not lose an
  // otherwise-good recording: fall back to the final observed URL.
  const last = [...trace.actions].reverse().find((a) => a.after);
  if (last?.after) return { kind: 'urlMatches', pattern: urlPattern(last.after.url, baseUrl, new Map()) };
  return { kind: 'textPresent', text: 'completed', caseSensitive: false };
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

function buildOutcomes(finish: Record<string, unknown>): OutcomeRule[] {
  const declared = Array.isArray(finish['businessOutcomes'])
    ? (finish['businessOutcomes'] as Record<string, unknown>[])
    : [];

  const rules: OutcomeRule[] = [];

  for (const d of declared) {
    const classification = (asEnum(d['classification'], ['business', 'recoverable', 'hard', 'escalate']) ??
      'business') as OutcomeRule['classification'];

    const detectKind = String(d['detectKind'] ?? 'textPresent');
    const detectValue = String(d['detectValue'] ?? '');
    if (!detectValue) continue;

    const detect: Condition =
      detectKind === 'urlMatches'
        ? { kind: 'urlMatches', pattern: detectValue }
        : detectKind === 'regexPresent'
          ? { kind: 'regexPresent', pattern: detectValue }
          : { kind: 'textPresent', text: detectValue, caseSensitive: false };

    const rule: OutcomeRule = {
      code: String(d['code'] ?? 'outcome').toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      title: String(d['title'] ?? d['code'] ?? 'Outcome'),
      classification,
      detect,
      scope: 'global',
      extract: [],
    };

    // The schema requires a recovery on `recoverable` and forbids one
    // elsewhere; satisfy that here rather than emitting something invalid.
    if (classification === 'recoverable') {
      const label = String(d['recoveryClickLabel'] ?? '').trim();
      rule.recovery = label
        ? {
            do: 'click',
            target: {
              description: `button labelled "${label}" that dismisses this state`,
              role: 'button',
              name: label,
              nameMatch: 'normalized',
              labelMatch: 'normalized',
              framePath: [],
              hints: {},
            },
          }
        : { do: 'waitAndRetry', waitMs: 2000, maxAttempts: 3 };
    }

    if (classification === 'escalate') {
      rule.operatorGuidance = String(
        d['operatorGuidance'] ?? 'Resolve this state manually, then hand control back.',
      );
    }

    rules.push(rule);
  }

  return rules;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Replace the institution-specific prefix so the artifact is product-scoped. */
export function templatize(url: string, baseUrl: string): string {
  return url.startsWith(baseUrl) ? `{{baseUrl}}${url.slice(baseUrl.length)}` : url;
}

export function detemplatize(url: string, baseUrl: string): string {
  return url.replace(/\{\{baseUrl\}\}/g, baseUrl.replace(/\/+$/, ''));
}

/** Stable hash over the artifact body, excluding the hash field itself. */
export function hashCapability(cap: Capability): string {
  const body = { ...cap, provenance: { ...cap.provenance, contentHash: undefined } };
  return createHash('sha256').update(canonicalJson(body)).digest('hex').slice(0, 32);
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`).join(',')}}`;
}

function toPolicyKind(tool: string): 'navigate' | 'click' | 'type' | 'select' | 'read' {
  switch (tool) {
    case 'navigate':
      return 'navigate';
    case 'click':
      return 'click';
    case 'type_text':
      return 'type';
    case 'select_option':
      return 'select';
    default:
      return 'read';
  }
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slugParam(s: string): string {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'value';
  return base.replace(/^(\d)/, 'p$1');
}
