/**
 * Deterministic element resolution.
 *
 * Replay does not replay a selector. It replays a *description* and resolves
 * it against the live surface with a pure scoring function: same snapshot plus
 * same descriptor always yields the same node, with no model in the loop and
 * no randomness anywhere. That is the "deterministic" in deterministic replay.
 *
 * Why scoring rather than a selector:
 *
 *   - Legacy element ids are tenant-specific (`ctl00$MainContent$txtMbr` vs
 *     `MainForm$Body$txtMbr`). An artifact holding an id is single-tenant by
 *     construction. A descriptor holding "textbox labelled Member ID inside
 *     the Member Search panel" transfers, and a per-tenant label overlay
 *     handles the vocabulary delta.
 *   - Multiple weak signals degrade gracefully where one strong signal fails
 *     hard. If the panel is renamed, role + label still carry the match — and
 *     the engine reports `missedSignals: ["container"]` so the drift is
 *     observable instead of silent.
 *
 * Two acceptance thresholds, both of which matter:
 *
 *   MIN_SCORE  — a weak best match is not a match. Better to fail with
 *                `target_not_found` than to click something plausible.
 *   MIN_MARGIN — the winner must beat the runner-up by a margin. Two
 *                equally-good candidates means the descriptor is under-specified;
 *                acting on a coin flip inside a banking system is the worst
 *                available option, so we stop with `target_ambiguous`.
 */

import type { ElementDescriptor, NameMatch } from '../../types/artifact.js';
import type { UiNode } from '../../types/surface.js';
import { normalizeText } from '../../types/surface.js';

/**
 * Acceptance thresholds, chosen against the weight table below rather than
 * picked round. The cases that set them:
 *
 *   role + exact label            30 + 40 = 70   must pass (the common case)
 *   role + exact name             30 + 30 = 60   must pass
 *   COMPATIBLE role + exact name  20 + 30 = 50   must pass — a tenant skin that
 *                                                renders a submit as an <a> is
 *                                                the exact drift this system
 *                                                claims to survive
 *   role alone, no name or label       30        must FAIL — too weak to act on
 *   WRONG role + exact label     -25 + 40 = 15   must FAIL
 *
 * So the floor sits at 45: above "role alone", below the weakest match we want
 * to honour.
 */
export const MIN_SCORE = 45;
export const MIN_MARGIN = 12;

/** Weights. Label outranks name because on legacy surfaces name is usually empty. */
const W = {
  label: 40,
  name: 30,
  role: 30,
  roleCompatible: 20,
  container: 15,
  framePath: 10,
  framePathMismatch: -22,
  /**
   * Ordinal is scored symmetrically (+/-) so that when it is the *only*
   * difference between two candidates the gap is 2x8=16, clearing MIN_MARGIN.
   * A one-sided bonus of 6 left genuine ties unresolvable, which meant a
   * descriptor could name "the second Amount box" and still be refused — the
   * disambiguator has to actually disambiguate.
   */
  ordinal: 8,
  inputType: 5,
  /** Deliberately near-zero: recorded for forensics, never load-bearing. */
  domId: 2,
} as const;

/** Roles that legitimately swap between tenant skins of the same product. */
const ROLE_COMPATIBLE: Record<string, string[]> = {
  button: ['link', 'menuitem'],
  link: ['button', 'menuitem'],
  textbox: ['combobox'],
  combobox: ['textbox', 'list'],
  cell: ['text', 'heading'],
  text: ['cell', 'heading'],
  heading: ['text', 'cell'],
};

export interface ResolutionSuccess {
  ok: true;
  node: UiNode;
  score: number;
  runnerUpScore: number | null;
  matchedSignals: string[];
  missedSignals: string[];
  candidateCount: number;
}

export interface ResolutionFailure {
  ok: false;
  reason: 'not_found' | 'ambiguous';
  candidateCount: number;
  /** Top few, so a failure report can show what it was choosing between. */
  candidates: Array<{ description: string; score: number; handle: string }>;
  bestScore: number;
}

export type Resolution = ResolutionSuccess | ResolutionFailure;

/** Text comparison in the four declared modes. Returns 0..1. */
export function matchStrength(expected: string | undefined, actual: string, mode: NameMatch): number {
  if (!expected) return 0;
  const e = normalizeText(expected);
  const a = normalizeText(actual);
  if (!e || !a) return 0;

  switch (mode) {
    case 'exact':
      return expected === actual ? 1 : 0;
    case 'normalized':
      if (e === a) return 1;
      // Partial credit for a containment relationship keeps small wording
      // drifts ("Member ID" -> "Member ID:") from breaking a match outright.
      if (a.includes(e) || e.includes(a)) {
        const ratio = Math.min(e.length, a.length) / Math.max(e.length, a.length);
        return ratio >= 0.6 ? 0.75 * ratio + 0.2 : 0;
      }
      return 0;
    case 'contains':
      return a.includes(e) ? 1 : 0;
    case 'regex':
      try {
        return new RegExp(expected, 'i').test(actual) ? 1 : 0;
      } catch {
        return 0;
      }
  }
}

export interface ResolveOptions {
  /**
   * Canonical label -> this tenant's wording, from the TenantBinding. Applied
   * to the descriptor before matching, which is what lets one artifact serve
   * "Member ID" and "Member Number" institutions without a re-record.
   */
  labelOverrides?: Record<string, string>;
  /** Skip the visible/enabled filter — used for `elementAbsent` conditions. */
  includeHidden?: boolean;
}

function applyOverrides(desc: ElementDescriptor, overrides: Record<string, string> | undefined): ElementDescriptor {
  if (!overrides) return desc;
  const remap = (v: string | undefined): string | undefined => {
    if (!v) return v;
    if (overrides[v] !== undefined) return overrides[v];
    // Also try a normalized-key lookup so overlays don't have to match casing.
    const key = Object.keys(overrides).find((k) => normalizeText(k) === normalizeText(v));
    return key ? overrides[key] : v;
  };
  return { ...desc, label: remap(desc.label), name: remap(desc.name), container: remap(desc.container) };
}

const ACTIONABLE = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'tab', 'menuitem']);

export function resolve(
  descriptor: ElementDescriptor,
  nodes: UiNode[],
  opts: ResolveOptions = {},
): Resolution {
  const desc = applyOverrides(descriptor, opts.labelOverrides);

  // Hard pre-filter. An invisible or disabled control is not a candidate for
  // an action — surfacing "not found" is more useful than clicking a ghost.
  const pool = nodes.filter((n) => {
    if (opts.includeHidden) return true;
    if (!n.visible) return false;
    if (ACTIONABLE.has(desc.role) && !n.enabled) return false;
    return true;
  });

  const scored = pool.map((node) => {
    const { score, matched, missed } = scoreNode(desc, node);
    return { node, score, matched, missed };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];

  if (!best || best.score < MIN_SCORE) {
    return {
      ok: false,
      reason: 'not_found',
      candidateCount: scored.length,
      candidates: scored.slice(0, 5).map(toCandidate),
      bestScore: best?.score ?? 0,
    };
  }

  if (runnerUp && best.score - runnerUp.score < MIN_MARGIN) {
    return {
      ok: false,
      reason: 'ambiguous',
      candidateCount: scored.length,
      candidates: scored.slice(0, 5).map(toCandidate),
      bestScore: best.score,
    };
  }

  return {
    ok: true,
    node: best.node,
    score: best.score,
    runnerUpScore: runnerUp?.score ?? null,
    matchedSignals: best.matched,
    missedSignals: best.missed,
    candidateCount: scored.length,
  };
}

function toCandidate(s: { node: UiNode; score: number }): { description: string; score: number; handle: string } {
  const n = s.node;
  const bits: string[] = [n.role];
  if (n.label) bits.push(`labelled "${n.label}"`);
  else if (n.name) bits.push(`named "${n.name}"`);
  if (n.container) bits.push(`in "${n.container}"`);
  return { description: bits.join(' '), score: Math.round(s.score), handle: n.handle };
}

function scoreNode(
  desc: ElementDescriptor,
  node: UiNode,
): { score: number; matched: string[]; missed: string[] } {
  let score = 0;
  const matched: string[] = [];
  const missed: string[] = [];

  // --- role ---------------------------------------------------------------
  if (node.role === desc.role) {
    score += W.role;
    matched.push('role');
  } else if ((ROLE_COMPATIBLE[desc.role] ?? []).includes(node.role)) {
    score += W.roleCompatible;
    matched.push('role~compatible');
  } else {
    missed.push('role');
    // A wrong-role candidate is very unlikely to be right; sink it hard so it
    // can never win on label alone.
    score -= 25;
  }

  // --- label (the strongest signal on legacy surfaces) --------------------
  if (desc.label) {
    const direct = matchStrength(desc.label, node.label, desc.labelMatch);
    // The same text may live in `name` on a differently-built tenant skin, so
    // accept a cross-field match at a small discount.
    const cross = matchStrength(desc.label, node.name, desc.labelMatch) * 0.85;
    const s = Math.max(direct, cross);
    if (s > 0) {
      score += W.label * s;
      matched.push(direct >= cross ? 'label' : 'label~name');
    } else {
      missed.push('label');
    }
  }

  // --- accessible name ----------------------------------------------------
  if (desc.name) {
    const direct = matchStrength(desc.name, node.name, desc.nameMatch);
    const cross = matchStrength(desc.name, node.label, desc.nameMatch) * 0.85;
    const s = Math.max(direct, cross);
    if (s > 0) {
      score += W.name * s;
      matched.push(direct >= cross ? 'name' : 'name~label');
    } else {
      missed.push('name');
    }
  }

  // --- container ----------------------------------------------------------
  if (desc.container) {
    const s = matchStrength(desc.container, node.container ?? '', 'normalized');
    if (s > 0) {
      score += W.container * s;
      matched.push('container');
    } else {
      missed.push('container');
    }
  }

  // --- frame path ---------------------------------------------------------
  // Scored only when the DESCRIPTOR makes a claim about the frame. An empty
  // `framePath` means "unspecified", not "must be the top document" — and the
  // difference matters: a recovery rule for a surprise interstitial cannot
  // know in advance which frame the interstitial will land in. Treating
  // unspecified as "top frame" made those rules silently unresolvable, so the
  // engine reported the recovery target as missing and let the step fail.
  if (desc.framePath.length > 0) {
    if (framePathMatches(desc.framePath, node.framePath)) {
      score += W.framePath;
      matched.push('framePath');
    } else {
      score += W.framePathMismatch;
      missed.push('framePath');
    }
  }

  // --- ordinal (tie-break only) -------------------------------------------
  // Scored both ways: an ordinal is only ever recorded when the semantic
  // signals were genuinely not unique, so at replay time it is the one thing
  // separating otherwise-identical candidates and must be able to do that on
  // its own.
  if (desc.ordinal !== undefined) {
    if (node.ordinal === desc.ordinal) {
      score += W.ordinal;
      matched.push('ordinal');
    } else {
      score -= W.ordinal;
      missed.push('ordinal');
    }
  }

  // --- weak hints ---------------------------------------------------------
  if (desc.hints.inputType && node.hints.inputType === desc.hints.inputType) {
    score += W.inputType;
    matched.push('inputType');
  }
  if (desc.hints.domId && node.hints.domId === desc.hints.domId) {
    score += W.domId;
    matched.push('domId(weak)');
  }

  return { score, matched, missed };
}

/**
 * Frame paths compare by tail, not by exact equality: legacy shells rename or
 * re-nest frames between versions, but the leaf frame that actually holds the
 * form is stable. Comparing the last segment keeps a recording working when a
 * vendor upgrade adds a wrapper frame.
 */
function framePathMatches(expected: string[], actual: string[]): boolean {
  if (expected.length === 0 && actual.length === 0) return true;
  if (expected.length === 0 || actual.length === 0) return false;
  const e = normalizeText(expected[expected.length - 1]);
  const a = normalizeText(actual[actual.length - 1]);
  if (e === a) return true;
  // Frame paths fall back to a URL path when unnamed; compare loosely.
  return a.includes(e) || e.includes(a);
}

/**
 * Build a descriptor from an observed node. Used by the artifact compiler when
 * turning a discovery trace into a durable capability.
 *
 * The rule enforced here is the important one: prefer semantic signals, and
 * only reach for `ordinal` when the node genuinely is not otherwise unique in
 * its snapshot. `domId` is copied into hints but never into a matching field.
 */
export function describeNode(node: UiNode, allNodes: UiNode[]): ElementDescriptor {
  const desc: ElementDescriptor = {
    description: humanDescription(node),
    role: node.role,
    nameMatch: 'normalized',
    labelMatch: 'normalized',
    framePath: node.framePath,
    hints: {
      domId: node.hints.domId,
      inputType: node.hints.inputType,
      placeholder: node.hints.placeholder,
      href: node.hints.href,
      tag: node.hints.tag,
    },
  };

  if (node.name) desc.name = node.name;
  if (node.label && node.label !== node.name) desc.label = node.label;
  if (node.container) desc.container = node.container;

  // Only pin an ordinal if the semantic signals really are not unique.
  const twins = allNodes.filter(
    (n) =>
      n.role === node.role &&
      normalizeText(n.name) === normalizeText(node.name) &&
      normalizeText(n.label) === normalizeText(node.label) &&
      normalizeText(n.container ?? '') === normalizeText(node.container ?? ''),
  );
  if (twins.length > 1) desc.ordinal = node.ordinal;

  return desc;
}

export function humanDescription(node: UiNode): string {
  const bits: string[] = [node.role];
  if (node.name) bits.push(`"${node.name}"`);
  else if (node.label) bits.push(`labelled "${node.label}"`);
  if (node.container) bits.push(`in the "${node.container}" panel`);
  if (node.framePath.length) bits.push(`(frame ${node.framePath.join('/')})`);
  return bits.join(' ');
}
