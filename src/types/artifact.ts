/**
 * The capability artifact — the contract between the model that discovered a
 * flow and every agent that will later invoke it.
 *
 * Three principles drove this schema:
 *
 * 1. NO SELECTORS. A target is described the way a human operator would
 *    describe it ("the text box labelled Member ID, in the Member Search
 *    panel"), never as `#ctl00$MainContent$txtMbr`. Replay *resolves* that
 *    description against the live surface with a deterministic scorer. This is
 *    the single decision that makes the artifact portable across tenant skins
 *    and, in principle, across surface kinds — a desktop UI Automation tree
 *    exposes the same role/name/container triple that a web a11y tree does.
 *
 * 2. THE ARTIFACT IS A FUNCTION SIGNATURE, NOT A SCRIPT. Typed inputs, typed
 *    outputs, declared business outcomes, and a checkpoint. An agent can read
 *    it and know what it needs, what it gets back, and what can legitimately
 *    happen — without reading the steps.
 *
 * 3. EXCEPTIONS ARE DECLARED, NOT DISCOVERED AT RUNTIME. `outcomes` and
 *    `recoveries` are part of the contract. A capability that only knows the
 *    happy path is, per the brief, not useful in production — so the schema
 *    makes the unhappy paths first-class fields rather than an afterthought in
 *    the executor.
 *
 * The schema is versioned and every artifact carries a content hash, so a
 * reviewer can tell at a glance whether the thing they approved is the thing
 * that ran.
 */

import { z } from 'zod';

export const SCHEMA_VERSION = '1.0.0' as const;

// ---------------------------------------------------------------------------
// Element targeting
// ---------------------------------------------------------------------------

/**
 * Roles are the ARIA/UIA intersection deliberately: every one of these has a
 * direct equivalent in Windows UI Automation and macOS AX, so a desktop surface
 * implementation reuses this vocabulary unchanged.
 */
export const ControlRole = z.enum([
  'button',
  'link',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'cell',
  'row',
  'heading',
  'text',
  'region',
  'dialog',
  'table',
  'list',
  'listitem',
  'image',
  'unknown',
]);
export type ControlRole = z.infer<typeof ControlRole>;

export const NameMatch = z.enum(['exact', 'normalized', 'contains', 'regex']);
export type NameMatch = z.infer<typeof NameMatch>;

/**
 * How a control is identified.
 *
 * Every field is a *signal*, not a requirement. The resolver scores candidates
 * against all signals and requires (a) a minimum score and (b) a margin over
 * the runner-up. That means a descriptor degrades gracefully: if a tenant
 * renames the panel, the role + label + ordinal still carry it, and the
 * resolver reports which signals matched so drift is observable rather than
 * silent.
 */
export const ElementDescriptor = z.object({
  /** Human-readable, for the reviewer. Never used for matching. */
  description: z.string(),

  role: ControlRole,

  /**
   * The accessible name, when the app bothers to provide one. Legacy table
   * layouts usually don't — hence `label` below.
   */
  name: z.string().optional(),
  nameMatch: NameMatch.default('normalized'),

  /**
   * The *visible* label a human would read for this control, derived from
   * structural context (adjacent table cell, preceding text node, wrapping
   * fieldset legend) when there is no accessible name. On the surfaces we care
   * about this is the highest-signal field there is.
   */
  label: z.string().optional(),
  labelMatch: NameMatch.default('normalized'),

  /**
   * Nearest enclosing titled region — a panel header, fieldset legend, or
   * table caption. Disambiguates the third "Amount" box on a dense screen.
   */
  container: z.string().optional(),

  /** Frame path from the top document, by frame name or url fragment. */
  framePath: z.array(z.string()).default([]),

  /**
   * Position among otherwise-identical candidates, 0-based. Last-resort tie
   * break; the resolver logs loudly when it has to use this, because an
   * ordinal-only match is the most fragile kind.
   */
  ordinal: z.number().int().nonnegative().optional(),

  /**
   * Attributes worth remembering but never trusted alone. Recorded so a human
   * reviewing a drift report can see what changed. `domId` in particular is
   * recorded and *deliberately not used for matching* — it is tenant-specific.
   */
  hints: z
    .object({
      domId: z.string().optional(),
      inputType: z.string().optional(),
      placeholder: z.string().optional(),
      href: z.string().optional(),
      tag: z.string().optional(),
    })
    .default({}),
});
export type ElementDescriptor = z.infer<typeof ElementDescriptor>;

// ---------------------------------------------------------------------------
// Values: the parameter-binding model
// ---------------------------------------------------------------------------

/**
 * What gets typed into a field.
 *
 * The important variant is `param`. During discovery, when the model types a
 * value that matches a declared input parameter, the compiler binds it as a
 * parameter reference instead of a literal. That is why the artifact contains
 * `{from: "param", name: "memberId"}` and not `12345`, and why a `secret`
 * parameter's value never appears in the artifact at all.
 */
export const ValueSource = z.discriminatedUnion('from', [
  z.object({ from: z.literal('literal'), value: z.string() }),
  z.object({ from: z.literal('param'), name: z.string() }),
  /** Value carried forward from an earlier step's extraction. */
  z.object({ from: z.literal('output'), name: z.string() }),
  /** Resolved from the secret store at replay time; never serialised. */
  z.object({ from: z.literal('secret'), ref: z.string() }),
]);
export type ValueSource = z.infer<typeof ValueSource>;

// ---------------------------------------------------------------------------
// Conditions: used for waits, checkpoints, and outcome detection
// ---------------------------------------------------------------------------

/**
 * A predicate over observed surface state.
 *
 * These are evaluated by the replay engine against the same normalized
 * snapshot the model saw, so a condition means the same thing at record time
 * and at replay time. That equivalence is what makes checkpoints trustworthy.
 */
// The input type is left open because `.default()` makes fields optional on the
// way in but required on the way out; pinning both sides of a recursive schema
// fights Zod's inference for no benefit. Output typing is exact.
export const Condition: z.ZodType<Condition, z.ZodTypeDef, any> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('urlMatches'), pattern: z.string() }),
    z.object({ kind: z.literal('textPresent'), text: z.string(), caseSensitive: z.boolean().default(false) }),
    z.object({ kind: z.literal('textAbsent'), text: z.string(), caseSensitive: z.boolean().default(false) }),
    z.object({ kind: z.literal('regexPresent'), pattern: z.string() }),
    z.object({ kind: z.literal('elementPresent'), target: ElementDescriptor }),
    z.object({ kind: z.literal('elementAbsent'), target: ElementDescriptor }),
    z.object({ kind: z.literal('httpStatusAtLeast'), status: z.number().int() }),
    z.object({ kind: z.literal('all'), of: z.array(Condition) }),
    z.object({ kind: z.literal('any'), of: z.array(Condition) }),
    z.object({ kind: z.literal('not'), of: Condition }),
  ]),
);
export type Condition =
  | { kind: 'urlMatches'; pattern: string }
  | { kind: 'textPresent'; text: string; caseSensitive: boolean }
  | { kind: 'textAbsent'; text: string; caseSensitive: boolean }
  | { kind: 'regexPresent'; pattern: string }
  | { kind: 'elementPresent'; target: ElementDescriptor }
  | { kind: 'elementAbsent'; target: ElementDescriptor }
  | { kind: 'httpStatusAtLeast'; status: number }
  | { kind: 'all'; of: Condition[] }
  | { kind: 'any'; of: Condition[] }
  | { kind: 'not'; of: Condition };

// ---------------------------------------------------------------------------
// Typed I/O
// ---------------------------------------------------------------------------

/**
 * Sensitivity is a first-class property of a parameter, not a naming
 * convention. It drives three separate behaviours: whether the value may be
 * shown to the model, whether it may be written to a log or artifact, and
 * whether its on-screen region is masked in screenshots.
 */
export const Sensitivity = z.enum(['public', 'internal', 'pii', 'secret']);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const ParamType = z.enum(['string', 'number', 'boolean', 'money', 'enum']);

export const InputParam = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: ParamType,
  description: z.string(),
  required: z.boolean().default(true),
  sensitivity: Sensitivity.default('internal'),
  enumValues: z.array(z.string()).optional(),
  pattern: z.string().optional(),
  example: z.string().optional(),
  default: z.string().optional(),
});
export type InputParam = z.infer<typeof InputParam>;

/**
 * How a value is lifted off the screen.
 *
 * `fromLabelledCell` is the one that matters for legacy apps: "find the cell
 * whose text is 'Current Balance', take the adjacent cell". That is how a
 * human reads these screens, and it survives column reordering and restyling
 * in a way that an nth-child selector does not.
 */
export const Extraction = z.discriminatedUnion('via', [
  z.object({ via: z.literal('elementText'), target: ElementDescriptor }),
  z.object({ via: z.literal('elementValue'), target: ElementDescriptor }),
  z.object({
    via: z.literal('fromLabelledCell'),
    label: z.string(),
    labelMatch: NameMatch.default('normalized'),
    framePath: z.array(z.string()).default([]),
    /** Which neighbour holds the value. */
    direction: z.enum(['right', 'below']).default('right'),
  }),
  /**
   * Two-dimensional grid read: "the Current Balance of the SAVINGS row".
   *
   * A one-dimensional label lookup cannot address a data grid — the cell to
   * the left of a balance is a different column's value, not its label. Both
   * axes are named the way an operator would say them, so the rule survives
   * column reordering and restyling, which a cell index does not.
   */
  z.object({
    via: z.literal('fromTableCell'),
    /** Matched against any cell in the row; usually the row's key column. */
    rowMatch: z.string(),
    columnLabel: z.string(),
    matchMode: NameMatch.default('contains'),
    framePath: z.array(z.string()).default([]),
  }),
  z.object({ via: z.literal('regexOnPageText'), pattern: z.string(), group: z.number().int().default(1) }),
  z.object({ via: z.literal('urlCapture'), pattern: z.string(), group: z.number().int().default(1) }),
]);
export type Extraction = z.infer<typeof Extraction>;

export const OutputField = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: ParamType,
  description: z.string(),
  sensitivity: Sensitivity.default('internal'),
  extraction: Extraction,
  /** Applied after extraction, before typing/validation. */
  transform: z.enum(['none', 'trim', 'stripCurrency', 'digitsOnly']).default('trim'),
  required: z.boolean().default(true),
});
export type OutputField = z.infer<typeof OutputField>;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Risk class is recorded per step at discovery time and re-derived from policy
 * at replay time. If the two disagree, replay refuses to run — that mismatch
 * means either the policy tightened or the artifact was tampered with, and
 * both deserve a human.
 */
export const RiskClass = z.enum(['safe', 'sensitive', 'confirmable', 'irreversible']);
export type RiskClass = z.infer<typeof RiskClass>;

export const StepAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), url: z.string() }),
  z.object({ action: z.literal('click'), target: ElementDescriptor }),
  z.object({ action: z.literal('type'), target: ElementDescriptor, value: ValueSource, clearFirst: z.boolean().default(true) }),
  z.object({ action: z.literal('select'), target: ElementDescriptor, value: ValueSource }),
  z.object({ action: z.literal('press'), key: z.string() }),
  z.object({ action: z.literal('waitFor'), condition: Condition }),
  z.object({ action: z.literal('read'), note: z.string().default('') }),
]);
export type StepAction = z.infer<typeof StepAction>;

export const Step = z.object({
  id: z.string(),
  /** One sentence, for the human reviewer and the run log. */
  intent: z.string(),
  act: StepAction,
  risk: RiskClass.default('safe'),

  /**
   * Asserted AFTER the action. A step without a checkpoint is a step that
   * assumes its click worked — the exact failure mode the brief calls out. The
   * compiler refuses to emit a state-changing step with no checkpoint.
   */
  checkpoint: Condition.optional(),

  /** Max wall-clock for action + checkpoint. Falls back to policy default. */
  timeoutMs: z.number().int().positive().optional(),

  /**
   * Retry only makes sense for transient conditions. Retrying a click that
   * submitted a transfer is how you double-post, so `retry` is rejected by the
   * compiler on `irreversible` and `confirmable` steps.
   */
  retry: z
    .object({ attempts: z.number().int().min(1).max(5).default(1), backoffMs: z.number().int().default(750) })
    .default({ attempts: 1, backoffMs: 750 }),
});
export type Step = z.infer<typeof Step>;

// ---------------------------------------------------------------------------
// Outcomes and recoveries — the unhappy paths, declared
// ---------------------------------------------------------------------------

/**
 * The three-way split the brief asks for, made structural.
 *
 * `business`     — a legitimate answer the caller needs ("no such member").
 *                  Terminal, reported as success-with-outcome, exit code 0.
 * `recoverable`  — the engine knows a fix (dismiss the interstitial, wait and
 *                  retry). Non-terminal; the engine applies `recovery` and
 *                  resumes the same step.
 * `hard`         — stop and surface a debuggable error.
 * `escalate`     — cannot be resolved by software but a person could. Routes
 *                  to the operator console rather than failing.
 */
export const OutcomeClass = z.enum(['business', 'recoverable', 'hard', 'escalate']);
export type OutcomeClass = z.infer<typeof OutcomeClass>;

export const RecoveryAction = z.discriminatedUnion('do', [
  z.object({ do: z.literal('click'), target: ElementDescriptor }),
  z.object({ do: z.literal('navigate'), url: z.string() }),
  z.object({ do: z.literal('waitAndRetry'), waitMs: z.number().int().default(2000), maxAttempts: z.number().int().default(3) }),
  z.object({ do: z.literal('restartFromStep'), stepId: z.string() }),
]);
export type RecoveryAction = z.infer<typeof RecoveryAction>;

export const OutcomeRule = z.object({
  /** Stable machine name the calling agent switches on. */
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  title: z.string(),
  classification: OutcomeClass,
  /** Evaluated against every observed state; first match by declaration order wins. */
  detect: Condition,
  /**
   * Where this rule is armed. `global` rules are checked after every step —
   * that is how session expiry and surprise dialogs get caught wherever they
   * appear, which is the whole point.
   */
  scope: z.union([z.literal('global'), z.array(z.string())]).default('global'),
  recovery: RecoveryAction.optional(),
  /** Extra context handed back to the caller / operator. */
  extract: z.array(OutputField).default([]),
  /** Shown to the human operator when classification is `escalate`. */
  operatorGuidance: z.string().optional(),

  /**
   * Who put this rule here.
   *
   * The discovery model only declares outcomes it inferred or went and looked
   * at, and it will miss some — the verification pass exists precisely to show
   * which. A reviewer closing those gaps before approval is the intended
   * workflow, not a workaround, but the two must stay distinguishable: a rule
   * a human asserted carries different evidential weight from one grounded in
   * observed text, and a reviewer reading this artifact in six months needs to
   * know which is which.
   */
  origin: z.enum(['discovered', 'reviewer']).default('discovered'),
  addedBy: z.string().optional(),
});
export type OutcomeRule = z.infer<typeof OutcomeRule>;

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

/**
 * Cross-tenant reuse without re-recording.
 *
 * The artifact is recorded against a *vendor product*, not an institution. A
 * tenant binding supplies only the deltas — base URL, label vocabulary, extra
 * guards. Because targets match on role + label + container rather than ids,
 * a label overlay is usually the entire delta between two institutions running
 * the same product.
 *
 * `overrides` is an escape hatch, keyed by step id, for the case where a tenant
 * really is different. It is intentionally awkward to use so it stays rare and
 * shows up in review.
 */
export const TenantBinding = z.object({
  tenantId: z.string(),
  displayName: z.string(),
  baseUrl: z.string(),
  productVersion: z.string().optional(),
  /** Canonical label -> this tenant's wording. Applied during resolution. */
  labelOverrides: z.record(z.string(), z.string()).default({}),
  /** Additional guards this tenant needs (e.g. a daily-notice interstitial). */
  additionalOutcomes: z.array(OutcomeRule).default([]),
  /** Per-step target replacement. Last resort; every entry is a review flag. */
  overrides: z.record(z.string(), StepAction).default({}),
  /** Populated by `handspan verify`; drives the drift report. */
  verification: z
    .object({
      lastVerifiedAt: z.string().optional(),
      lastResult: z.enum(['pass', 'degraded', 'fail', 'unverified']).default('unverified'),
      notes: z.string().optional(),
    })
    .default({ lastResult: 'unverified' }),
});
export type TenantBinding = z.infer<typeof TenantBinding>;

// ---------------------------------------------------------------------------
// The capability
// ---------------------------------------------------------------------------

export const SurfaceKind = z.enum(['web', 'legacy_web', 'desktop', 'terminal']);
export type SurfaceKind = z.infer<typeof SurfaceKind>;

export const ApprovalState = z.enum(['draft', 'in_review', 'approved', 'deprecated']);
export type ApprovalState = z.infer<typeof ApprovalState>;

export const Capability = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),

  /** Stable identity. `id` is what an agent calls; `version` is what changed. */
  id: z.string().regex(/^[a-z][a-z0-9_.]*$/),
  version: z.number().int().positive(),
  name: z.string(),
  /** Written for a calling agent's tool description. Keep it operational. */
  description: z.string(),

  surface: z.object({
    kind: SurfaceKind,
    /** The vendor product, NOT the institution. Recording is product-scoped. */
    product: z.string(),
    productVersion: z.string().optional(),
    /** Which tenant this was recorded against, for provenance. */
    recordedOnTenant: z.string(),
    /** Entry point as a pattern; `{{baseUrl}}` is substituted per tenant. */
    entryUrl: z.string(),
  }),

  inputs: z.array(InputParam).default([]),
  outputs: z.array(OutputField).default([]),
  steps: z.array(Step).min(1),

  /** Terminal assertion. If this fails, the run failed — no partial credit. */
  successCheckpoint: Condition,

  outcomes: z.array(OutcomeRule).default([]),

  /** Bindings for institutions other than the recording tenant. */
  tenants: z.array(TenantBinding).default([]),

  policy: z.object({
    /** Highest risk class present in `steps`. Cheap gate for callers. */
    maxRisk: RiskClass,
    /**
     * When true, a caller must pass `confirm: <capability id>` to run
     * unattended. Set automatically when any step is `confirmable`.
     */
    requiresConfirmation: z.boolean().default(false),
    /** Origins this capability is permitted to touch, echoed from policy.yaml. */
    allowedOrigins: z.array(z.string()).default([]),
  }),

  governance: z.object({
    approval: ApprovalState.default('draft'),
    /** Replay stability, populated by repeated verification runs. */
    stability: z
      .object({ runs: z.number().int().default(0), successes: z.number().int().default(0) })
      .default({ runs: 0, successes: 0 }),
    reviewedBy: z.string().optional(),
    notes: z.string().optional(),
  }),

  provenance: z.object({
    discoveredAt: z.string(),
    /** Model + settings, so a bad recording is traceable to a bad run. */
    model: z.string(),
    effort: z.string().optional(),
    /** Points at the evidence directory. The transcript is NOT inlined here. */
    discoveryRunId: z.string(),
    /** sha256 of the canonical artifact body, excluding this field. */
    contentHash: z.string().optional(),
    generator: z.string().default('handspan'),
  }),
});
export type Capability = z.infer<typeof Capability>;

// ---------------------------------------------------------------------------
// Compile-time invariants
// ---------------------------------------------------------------------------

/**
 * Structural rules the type system can't express. Enforced when an artifact is
 * written AND again when it is loaded for replay, so a hand-edited file can't
 * smuggle in a retry on an irreversible step.
 */
export function validateCapability(cap: Capability): string[] {
  const problems: string[] = [];
  const paramNames = new Set(cap.inputs.map((p) => p.name));
  const outputNames = new Set(cap.outputs.map((o) => o.name));
  const stepIds = new Set<string>();

  for (const step of cap.steps) {
    if (stepIds.has(step.id)) problems.push(`duplicate step id: ${step.id}`);
    stepIds.add(step.id);

    const act = step.act;

    if ((act.action === 'type' || act.action === 'select') && act.value.from === 'param') {
      if (!paramNames.has(act.value.name)) {
        problems.push(`step ${step.id} references undeclared input parameter "${act.value.name}"`);
      }
    }
    if ((act.action === 'type' || act.action === 'select') && act.value.from === 'output') {
      if (!outputNames.has(act.value.name)) {
        problems.push(`step ${step.id} references undeclared output "${act.value.name}"`);
      }
    }

    // A state-changing action with no checkpoint is an unverified assumption.
    const stateChanging = act.action === 'click' || act.action === 'navigate' || act.action === 'press';
    if (stateChanging && !step.checkpoint) {
      problems.push(`step ${step.id} (${act.action}) has no checkpoint — cannot verify the action took effect`);
    }

    // Never auto-retry something that may have already committed.
    if (step.retry.attempts > 1 && (step.risk === 'irreversible' || step.risk === 'confirmable')) {
      problems.push(`step ${step.id} is ${step.risk} and must not auto-retry (attempts=${step.retry.attempts})`);
    }

    // A literal that looks like a secret should have been bound to a parameter.
    if (act.action === 'type' && act.value.from === 'literal' && looksSecret(act.value.value)) {
      problems.push(`step ${step.id} embeds a literal that looks like a credential; bind it to a secret parameter`);
    }
  }

  for (const rule of cap.outcomes) {
    if (rule.classification === 'recoverable' && !rule.recovery) {
      problems.push(`outcome "${rule.code}" is recoverable but declares no recovery action`);
    }
    if (rule.classification !== 'recoverable' && rule.recovery) {
      problems.push(`outcome "${rule.code}" declares a recovery but is classified ${rule.classification}`);
    }
    if (Array.isArray(rule.scope)) {
      for (const s of rule.scope) {
        if (!stepIds.has(s)) problems.push(`outcome "${rule.code}" scoped to unknown step "${s}"`);
      }
    }
  }

  // Secrets must never be declared as outputs — that would persist them.
  for (const out of cap.outputs) {
    if (out.sensitivity === 'secret') {
      problems.push(`output "${out.name}" is classified secret; secrets must not be returned to callers`);
    }
  }

  /**
   * Every regular expression in the artifact must actually compile.
   *
   * Condition evaluation has to fail closed, so an uncompilable pattern
   * silently evaluates to `false` forever. A capability whose outcome
   * detectors cannot compile therefore *looks* like it declares business
   * outcomes while declaring none of them — and the first sign is a legitimate
   * "no such member" being reported as a checkpoint failure in production.
   * Cheap to check here, expensive to debug there.
   */
  const badPatterns: string[] = [];
  const checkCondition = (c: Condition, where: string): void => {
    switch (c.kind) {
      case 'urlMatches':
      case 'regexPresent':
        try {
          new RegExp(c.pattern, 'is');
        } catch (e) {
          badPatterns.push(`${where}: /${c.pattern}/ — ${(e as Error).message}`);
        }
        break;
      case 'all':
      case 'any':
        c.of.forEach((sub, i) => checkCondition(sub, `${where}[${i}]`));
        break;
      case 'not':
        checkCondition(c.of, where);
        break;
      default:
        break;
    }
  };

  for (const step of cap.steps) {
    if (step.checkpoint) checkCondition(step.checkpoint, `step ${step.id} checkpoint`);
    if (step.act.action === 'waitFor') checkCondition(step.act.condition, `step ${step.id} waitFor`);
  }
  checkCondition(cap.successCheckpoint, 'successCheckpoint');
  for (const rule of cap.outcomes) checkCondition(rule.detect, `outcome "${rule.code}" detector`);
  for (const t of cap.tenants) {
    for (const rule of t.additionalOutcomes) {
      checkCondition(rule.detect, `tenant ${t.tenantId} outcome "${rule.code}" detector`);
    }
  }
  for (const out of cap.outputs) {
    const ex = out.extraction;
    if (ex.via === 'regexOnPageText' || ex.via === 'urlCapture') {
      try {
        new RegExp(ex.pattern, 'is');
      } catch (e) {
        badPatterns.push(`output "${out.name}" extraction: /${ex.pattern}/ — ${(e as Error).message}`);
      }
    }
  }

  for (const p of badPatterns) {
    problems.push(
      `invalid regular expression in ${p}. Note ECMAScript does not support inline flag groups such as (?i); patterns are compiled case-insensitively already.`,
    );
  }

  const declaredMax = cap.policy.maxRisk;
  const actualMax = highestRisk(cap.steps.map((s) => s.risk));
  if (declaredMax !== actualMax) {
    problems.push(`policy.maxRisk is "${declaredMax}" but the highest step risk is "${actualMax}"`);
  }

  return problems;
}

const RISK_ORDER: RiskClass[] = ['safe', 'sensitive', 'confirmable', 'irreversible'];

export function highestRisk(risks: RiskClass[]): RiskClass {
  return risks.reduce<RiskClass>(
    (acc, r) => (RISK_ORDER.indexOf(r) > RISK_ORDER.indexOf(acc) ? r : acc),
    'safe',
  );
}

export function riskAtLeast(a: RiskClass, b: RiskClass): boolean {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b);
}

function looksSecret(v: string): boolean {
  if (v.length < 6) return false;
  return /(?:sk-ant-|bearer\s|^[A-Za-z0-9+/]{32,}={0,2}$)/i.test(v) || /pass(word)?[:=]/i.test(v);
}

export function parseCapability(raw: unknown): Capability {
  const cap = Capability.parse(raw);
  const problems = validateCapability(cap);
  if (problems.length) {
    throw new Error(`Capability failed structural validation:\n  - ${problems.join('\n  - ')}`);
  }
  return cap;
}
