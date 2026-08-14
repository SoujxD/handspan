/**
 * Policy engine — the allowlist and the risk model.
 *
 * Placement matters as much as content: this sits *below* both the agent loop
 * and the replay engine, at the last point before an action reaches a surface.
 * The model can propose whatever it likes and a hand-edited artifact can ask
 * for whatever it likes; neither can act without a `PolicyDecision` from here.
 *
 * The risk model is structural rather than a list of known-bad selectors,
 * because a selector list is a per-tenant artifact and would need rebuilding
 * for every institution. Classifying on the *accessible name of the control*
 * ("Confirm and Open Account", "Purge Member Records") transfers across skins
 * for free, and degrades in the safe direction: an unrecognised control that
 * happens to be destructive still has to pass the navigation allowlist and
 * still lands in evidence.
 *
 * Known limit, stated plainly: name-based classification is defeated by a
 * button labelled "OK" that wires a transfer. That is why the navigation
 * allowlist is a separate, independent gate, and why `irreversible` blocks
 * rather than warns. The REPORT discusses what a production version adds.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { RiskClass } from '../types/artifact.js';
import type { RedactionPattern } from './redaction.js';

export interface PolicyFile {
  version: number;
  navigation: {
    allowedOrigins: string[];
    allowedPathPatterns: string[];
    deniedPathPatterns: string[];
  };
  actions: { allowed: string[]; denied: string[] };
  risk: {
    irreversiblePatterns: string[];
    confirmablePatterns: string[];
    sensitiveNamePatterns: string[];
  };
  redaction: { patterns: RedactionPattern[]; scrubRuntimeSecrets: boolean };
  limits: {
    maxStepsPerDiscovery: number;
    maxWallClockMsPerDiscovery: number;
    maxStepsPerReplay: number;
    defaultActionTimeoutMs: number;
    maxConsecutiveNoProgress: number;
  };
}

export type PolicyDecision =
  | { allow: true; risk: RiskClass; reason: string }
  | { allow: false; risk: RiskClass; reason: string; remediation: string };

/** What the engine needs to know about a proposed action to judge it. */
export interface ActionIntent {
  kind: 'navigate' | 'click' | 'type' | 'select' | 'press' | 'read' | 'waitFor' | 'screenshot';
  /** For navigate. */
  url?: string;
  /** Accessible name / derived label of the target control. */
  targetName?: string;
  /** Enclosing panel title, included in the risk text so "Delete" in an
   *  "Administration" panel is judged on both. */
  targetContainer?: string;
  /** For `type`: the label of the field, used for sensitivity classification. */
  fieldLabel?: string;
}

export interface PolicyContext {
  /** Unattended = an agent triggered this with no human watching. */
  mode: 'attended' | 'unattended';
  /** Caller-supplied confirmation token for `confirmable` steps. */
  confirmationToken?: string;
  /** The capability id the token must name, to stop token reuse across flows. */
  capabilityId?: string;
}

export class PolicyEngine {
  private readonly irreversible: RegExp[];
  private readonly confirmable: RegExp[];
  private readonly sensitive: RegExp[];

  constructor(readonly file: PolicyFile) {
    // Compiled with `i` here rather than with an inline flag in the YAML.
    // ECMAScript has no `(?i)` syntax, so an inline flag throws — and because
    // this runs in the constructor, one bad pattern takes the whole safety
    // layer down at startup. Compiling centrally also guarantees no policy
    // author can write a case-sensitive rule that silently misses "PURGE".
    this.irreversible = compileAll(file.risk.irreversiblePatterns, 'risk.irreversiblePatterns');
    this.confirmable = compileAll(file.risk.confirmablePatterns, 'risk.confirmablePatterns');
    this.sensitive = compileAll(file.risk.sensitiveNamePatterns, 'risk.sensitiveNamePatterns');
  }

  static load(path: string): PolicyEngine {
    const raw = parseYaml(readFileSync(path, 'utf8')) as PolicyFile;
    return new PolicyEngine(raw);
  }

  get limits() {
    return this.file.limits;
  }

  get allowedOrigins(): string[] {
    return this.file.navigation.allowedOrigins;
  }

  /**
   * Classify an action's risk without deciding on it. Used by the compiler to
   * stamp `Step.risk` at record time, and again by the replay engine, which
   * compares the two and refuses to run if they disagree.
   */
  classify(intent: ActionIntent): RiskClass {
    if (intent.kind === 'read' || intent.kind === 'waitFor' || intent.kind === 'screenshot') return 'safe';

    if (intent.kind === 'type' || intent.kind === 'select') {
      const label = `${intent.fieldLabel ?? ''} ${intent.targetName ?? ''}`;
      return this.sensitive.some((r) => r.test(label)) ? 'sensitive' : 'safe';
    }

    // Judge a click on the control text plus its container, so "Delete" inside
    // an "Administration" panel reads as what it is.
    const text = `${intent.targetName ?? ''} ${intent.targetContainer ?? ''}`.trim();
    if (!text) return 'safe';
    if (this.irreversible.some((r) => r.test(text))) return 'irreversible';
    if (this.confirmable.some((r) => r.test(text))) return 'confirmable';
    return 'safe';
  }

  /** The gate. Called immediately before every action, in both modes. */
  evaluate(intent: ActionIntent, ctx: PolicyContext): PolicyDecision {
    // 1. Action kind must be on the allowlist.
    if (this.file.actions.denied.includes(intent.kind)) {
      return {
        allow: false,
        risk: 'safe',
        reason: `Action kind "${intent.kind}" is explicitly denied by policy.`,
        remediation: `Remove the action, or add "${intent.kind}" to actions.allowed in policy.yaml if it is genuinely required.`,
      };
    }
    if (!this.file.actions.allowed.includes(intent.kind)) {
      return {
        allow: false,
        risk: 'safe',
        reason: `Action kind "${intent.kind}" is not on the policy allowlist.`,
        remediation: `Add "${intent.kind}" to actions.allowed in policy.yaml.`,
      };
    }

    // 2. Navigation must satisfy the origin AND path allowlist.
    if (intent.kind === 'navigate') {
      const nav = this.checkNavigation(intent.url ?? '');
      if (!nav.allow) return nav;
    }

    // 3. Risk gate.
    const risk = this.classify(intent);

    if (risk === 'irreversible') {
      // Never unattended, ever, regardless of tokens. An irreversible action
      // needs a person; that is the definition.
      return {
        allow: false,
        risk,
        reason: `Blocked: the control "${intent.targetName ?? '(unnamed)'}" is classified irreversible.`,
        remediation:
          'Irreversible actions require a human decision. The run escalates to the operator console rather than proceeding.',
      };
    }

    if (risk === 'confirmable' && ctx.mode === 'unattended') {
      const ok = ctx.confirmationToken && ctx.confirmationToken === ctx.capabilityId;
      if (!ok) {
        return {
          allow: false,
          risk,
          reason: `Blocked: "${intent.targetName ?? '(unnamed)'}" commits state and this is an unattended run with no confirmation.`,
          remediation: `Re-invoke with confirm="${ctx.capabilityId ?? '<capability id>'}" to authorise the commit, or run attended.`,
        };
      }
    }

    return { allow: true, risk, reason: `Permitted (${risk}).` };
  }

  checkNavigation(url: string): PolicyDecision {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        allow: false,
        risk: 'safe',
        reason: `Navigation target is not a valid absolute URL: "${url}"`,
        remediation: 'Use an absolute URL derived from the tenant base URL.',
      };
    }

    const origin = `${parsed.protocol}//${parsed.host}`;
    if (!this.file.navigation.allowedOrigins.includes(origin)) {
      return {
        allow: false,
        risk: 'safe',
        reason: `Origin "${origin}" is not on the navigation allowlist.`,
        remediation: `Add "${origin}" to navigation.allowedOrigins in policy.yaml if this institution is in scope.`,
      };
    }

    for (const pattern of this.file.navigation.deniedPathPatterns) {
      if (pathMatches(pattern, parsed.pathname)) {
        return {
          allow: false,
          risk: 'irreversible',
          reason: `Path "${parsed.pathname}" matches a denied pattern ("${pattern}").`,
          remediation: 'This area is off-limits to automation. If a human needs it, escalate.',
        };
      }
    }

    const allowed = this.file.navigation.allowedPathPatterns.some((p) => pathMatches(p, parsed.pathname));
    if (!allowed) {
      return {
        allow: false,
        risk: 'safe',
        reason: `Path "${parsed.pathname}" does not match any allowed pattern.`,
        remediation: `Add the route to navigation.allowedPathPatterns in policy.yaml (use :param for variable segments).`,
      };
    }

    return { allow: true, risk: 'safe', reason: 'Navigation permitted.' };
  }

  /** True when a field's label suggests it will hold regulated data. */
  isSensitiveLabel(label: string): boolean {
    return this.sensitive.some((r) => r.test(label));
  }
}

/**
 * Compile policy patterns, naming the offending rule when one is malformed.
 *
 * Throws rather than skipping the bad rule on purpose: a risk pattern that
 * silently fails to compile is a guardrail that silently does not exist, and
 * the resulting system looks healthy while enforcing nothing.
 */
function compileAll(patterns: string[], where: string): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern, 'i');
    } catch (e) {
      throw new Error(
        `policy.yaml: invalid regular expression in ${where}: /${pattern}/ — ${(e as Error).message}. ` +
          `Note ECMAScript has no inline flags such as (?i); these patterns are compiled case-insensitively already.`,
      );
    }
  });
}

/**
 * Path pattern matching with `:param` wildcards.
 *
 * Segment-wise rather than regex-on-the-whole-string, so `/member/:id` cannot
 * accidentally match `/member/1/admin`. Length equality is required for the
 * same reason.
 */
export function pathMatches(pattern: string, path: string): boolean {
  const p = pattern.replace(/\/+$/, '') || '/';
  const t = path.replace(/\/+$/, '') || '/';
  const pSeg = p.split('/');
  const tSeg = t.split('/');

  // A trailing `:rest` absorbs the remainder, for whole-subtree denials.
  const hasRest = pSeg[pSeg.length - 1] === ':rest';
  if (!hasRest && pSeg.length !== tSeg.length) return false;
  if (hasRest && tSeg.length < pSeg.length - 1) return false;

  for (let i = 0; i < pSeg.length; i++) {
    const ps = pSeg[i]!;
    if (ps === ':rest') return true;
    const ts = tSeg[i];
    if (ts === undefined) return false;
    if (ps.startsWith(':')) {
      if (ts.length === 0) return false;
      continue;
    }
    if (ps !== ts) return false;
  }
  return true;
}
