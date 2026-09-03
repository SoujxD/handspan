/**
 * Reviewed self-repair.
 *
 * A capability that has drifted is not broken code — it is a description that
 * no longer matches the world. The repair for that is a change to the artifact,
 * and the brief's stretch list (§8) calls this "assisted fallback: on replay
 * failure, allow a bounded, policy-checked LLM recovery for a single step
 * (never open-ended), and record it as evidence."
 *
 * This takes that idea and moves it somewhere better. Recovering *inside* a
 * replay would put a model back in the decision loop — the one property the
 * whole system exists to avoid — and it would fix one run while leaving the
 * next thousand to fail the same way. So repair happens *between* runs, and its
 * output is not an action: it is a **proposed new version of the artifact**,
 * written as a draft, diffed for a human, and approved by a person before
 * anything replays against it.
 *
 * Three constraints make that safe:
 *
 * 1. **The model is the fallback, not the mechanism.** Drift analysis resolves
 *    most renames deterministically, for free, with no model call at all. The
 *    model is asked only about findings the analyser could not explain — a
 *    genuinely ambiguous candidate set. The common case costs zero tokens, and
 *    that is the same "spend the model once, then stop" argument the system
 *    makes about discovery, applied to its own maintenance.
 *
 * 2. **It may only choose, never invent.** The proposal tool takes a label that
 *    must appear verbatim among the candidates actually observed on screen. A
 *    model cannot hallucinate a control into existence, because a label it made
 *    up fails validation before it reaches an artifact.
 *
 * 3. **It may change how the flow is FOUND, never how it is VERIFIED.** Label
 *    overrides live in the tenant binding and feed the resolver. Checkpoints,
 *    steps, outcomes, risk and policy are asserted byte-identical after the
 *    patch. This is the line that matters: the cheapest way to make a broken
 *    capability pass is to weaken the assertion that proves it worked, and a
 *    repair tool permitted to do that is a machine for converting outages into
 *    silent data corruption. It refuses, and escalates to a human instead.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { anthropicClient } from '../config.js';
import { withTransientRetry } from '../agent/loop.js';
import { hashCapability } from '../agent/compiler.js';
import { parseCapability, validateCapability, type Capability } from '../types/artifact.js';
import type { DriftFinding, DriftReport, LabelRename } from '../replay/drift.js';

export interface ProposedRename extends LabelRename {
  /** Where it came from. Deterministic proposals need no model and no trust. */
  source: 'analysis' | 'model';
  reason: string;
}

export interface RepairProposal {
  capabilityId: string;
  tenantId: string;
  fromVersion: number;
  renames: ProposedRename[];
  /** Findings this proposal deliberately does not attempt. */
  refused: Array<{ stepId: string; kind: string; why: string }>;
  modelCalls: number;
}

/**
 * Findings a patch is allowed to attempt at all.
 *
 * `structural` is excluded as well as `checkpoint`: a renamed panel means the
 * descriptor now points at something with a different meaning, and papering
 * over that with a label overlay hides a layout change that a person needs to
 * see. Both are reported, neither is repaired.
 */
export function isRepairable(f: DriftFinding): boolean {
  return f.kind === 'vocabulary';
}

export function refusalFor(f: DriftFinding): string {
  switch (f.kind) {
    case 'checkpoint':
      return 'Checkpoint drift. A repair may change how the flow is found, never how it is verified — the only way to make this pass is to weaken the assertion that proves the step worked.';
    case 'structural':
      return 'Structural drift. The control now sits in a differently-named container, so the descriptor means something slightly different. That is a layout change for a human to review, not a vocabulary delta.';
    case 'missing':
      return 'No candidate on screen resembled the declared control. Either the flow changed or the run was not where the artifact expected — renaming nothing would fix it.';
    case 'ambiguous':
      return 'Several candidates were equally plausible and none could be chosen safely.';
    default:
      return 'Not repairable by a label overlay.';
  }
}

// ---------------------------------------------------------------------------
// The bounded model call
// ---------------------------------------------------------------------------

const ASSIST_TOOL: Anthropic.Tool = {
  name: 'propose_rename',
  description:
    'Propose that a control the artifact calls one thing is now called another. The new label MUST be copied ' +
    'verbatim from the observed candidates — you are choosing among controls that exist, never describing one. ' +
    'If no candidate is clearly the same control, do not propose anything.',
  input_schema: {
    type: 'object',
    properties: {
      stepId: { type: 'string' },
      from: { type: 'string', description: 'The label the artifact declares.' },
      to: { type: 'string', description: 'The label of the observed candidate that is the same control.' },
      reason: { type: 'string', description: 'One sentence: why this candidate is the same control.' },
    },
    required: ['stepId', 'from', 'to', 'reason'],
  },
};

const ASSIST_PROMPT = `You are reviewing a UI automation capability that stopped matching after the vendor re-worded an application.

You are given, for one step: the control the capability declares, and the controls actually present on screen with the score each one received from a deterministic resolver. The resolver refused to choose because no candidate was clearly correct.

Decide whether one of the observed candidates is plainly the SAME control under a new name.

Rules:
- Copy the new label verbatim from a candidate. Never write a label that is not in the list.
- The same control keeps its role. A text box does not become a button.
- A rename usually preserves meaning: "Member ID" -> "Member Number" is the same field; "Member ID" -> "Last Name" is a different one, however close the scores are.
- If two candidates are genuinely plausible, or none is, call nothing. An unrepaired capability is a normal outcome; a wrongly repaired one silently operates on the wrong field of a banking record.`;

export interface AssistDeps {
  model: string;
  /** Candidates seen for this finding, from the failure report. */
  candidatesFor(f: DriftFinding): Array<{ description: string; score: number; role?: string; label?: string }>;
  declaredFor(f: DriftFinding): { role?: string; label?: string; container?: string; description: string } | undefined;
}

/**
 * One model call, for one finding, with one tool.
 *
 * Deliberately not a loop and not a conversation. There is exactly one
 * question — "is one of these the same control?" — and a model that cannot
 * answer it in one turn is a model that should not be answering it.
 */
export async function assistRename(
  finding: DriftFinding,
  deps: AssistDeps,
): Promise<{ rename?: ProposedRename; calls: number }> {
  const declared = deps.declaredFor(finding);
  const candidates = deps.candidatesFor(finding);
  if (!declared?.label || !candidates.length) return { calls: 0 };

  const client = anthropicClient();
  const response = await withTransientRetry(
    () =>
      client.messages.create({
        model: deps.model,
        max_tokens: 1200,
        system: [{ type: 'text', text: ASSIST_PROMPT }],
        tools: [ASSIST_TOOL],
        messages: [
          {
            role: 'user',
            content:
              `Step ${finding.stepId} — ${finding.intent}\n\n` +
              `The capability declares:\n  ${declared.description}\n` +
              `  role="${declared.role ?? ''}" label="${declared.label}"` +
              `${declared.container ? ` container="${declared.container}"` : ''}\n\n` +
              `Controls observed on screen:\n` +
              candidates
                .map((c) => `  - ${c.description}  [role=${c.role ?? '?'} label="${c.label ?? ''}" score=${c.score}]`)
                .join('\n') +
              `\n\nIs one of these the same control under a new name?`,
          },
        ],
      }) as Promise<Anthropic.Message>,
    () => undefined,
  );

  const use = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'propose_rename',
  );
  if (!use) return { calls: 1 };

  const input = use.input as { from?: string; to?: string; reason?: string };
  if (!input.from || !input.to) return { calls: 1 };

  // The model may only choose. A label that was not observed is rejected here,
  // before it can reach an artifact — this is the guard that makes a
  // hallucinated control structurally impossible rather than merely unlikely.
  const observed = candidates.some((c) => c.label === input.to);
  if (!observed) return { calls: 1 };

  // And it may only rename the control the capability actually declared.
  if (input.from !== declared.label) return { calls: 1 };

  return {
    rename: {
      from: input.from,
      to: input.to,
      occurrences: 1,
      source: 'model',
      reason: input.reason ?? 'proposed by review model',
    },
    calls: 1,
  };
}

// ---------------------------------------------------------------------------
// Applying a patch — and proving it changed only what it was allowed to
// ---------------------------------------------------------------------------

/**
 * Everything a repair is forbidden to touch, in one place.
 *
 * Comparing serialised subtrees rather than hand-checking fields is deliberate:
 * a field added to the schema next year is covered by this the day it exists,
 * whereas a hand-written check silently stops covering the thing it was written
 * for. The failure mode of the strict version is a loud false positive; the
 * failure mode of the loose version is a capability quietly repaired into
 * something nobody approved.
 */
function immutableFace(cap: Capability): string {
  return JSON.stringify({
    id: cap.id,
    steps: cap.steps,
    successCheckpoint: cap.successCheckpoint,
    outcomes: cap.outcomes,
    inputs: cap.inputs,
    outputs: cap.outputs,
    policy: cap.policy,
    surface: cap.surface,
  });
}

export interface PatchResult {
  ok: boolean;
  capability?: Capability;
  problems: string[];
}

/**
 * Produce the next version with the overlay applied, or explain why not.
 *
 * The patch is always a *new version*. Editing the approved artifact in place
 * would destroy the thing that makes approval meaningful — a reviewer signed
 * off on a specific content hash, and an in-place edit invalidates that
 * signature while leaving it displayed.
 */
export function applyRenames(
  cap: Capability,
  tenantId: string,
  renames: ProposedRename[],
  meta: { nextVersion: number; runId: string; model: string | null },
): PatchResult {
  const problems: string[] = [];
  if (!renames.length) return { ok: false, problems: ['no renames to apply'] };

  const draft: Capability = JSON.parse(JSON.stringify(cap));
  const binding = draft.tenants.find((t) => t.tenantId === tenantId);
  if (!binding) return { ok: false, problems: [`capability has no binding for tenant "${tenantId}"`] };

  for (const r of renames) {
    const existing = binding.labelOverrides[r.from];
    if (existing !== undefined && existing !== r.to) {
      problems.push(
        `"${r.from}" is already bound to "${existing}" for ${tenantId}; a repair will not silently rebind it`,
      );
      continue;
    }
    binding.labelOverrides[r.from] = r.to;
  }

  draft.version = meta.nextVersion;
  draft.governance.approval = 'draft';
  // Approval does not survive a patch. A reviewer approved the previous
  // version; they have not seen this one.
  delete (draft.governance as { reviewedBy?: string }).reviewedBy;
  draft.governance.notes =
    `Repair proposal from run ${meta.runId}: ` +
    renames.map((r) => `"${r.from}" -> "${r.to}" (${r.source})`).join(', ') +
    `. Label overlay only; steps, checkpoints, outcomes and policy unchanged. Requires review.`;
  draft.provenance.contentHash = hashCapability(draft);

  if (immutableFace(draft) !== immutableFace(cap)) {
    problems.push(
      'the patch changed something outside the tenant label overlay — refusing. A repair may change how the flow is found, never what it does or how it is verified.',
    );
  }

  problems.push(...validateCapability(draft));

  // Re-parse the way the store will, so a patch that cannot be loaded back is
  // caught here rather than at the next replay.
  try {
    parseCapability(JSON.parse(JSON.stringify(draft)));
  } catch (e) {
    problems.push(`patched artifact fails schema validation: ${(e as Error).message}`);
  }

  return problems.length ? { ok: false, problems } : { ok: true, capability: draft, problems: [] };
}

/** What a reviewer reads before approving. Deliberately small and complete. */
export function renderProposal(
  proposal: RepairProposal,
  patched: Capability | undefined,
  problems: string[],
): string {
  const bar = '─'.repeat(88);
  const out: string[] = [''];

  out.push(`  Repair proposal — ${proposal.capabilityId} v${proposal.fromVersion} @ ${proposal.tenantId}`);
  out.push(`  ${bar}`);

  if (proposal.renames.length) {
    out.push('  Proposed change: tenant label overlay only');
    for (const r of proposal.renames) {
      out.push(`    ~ "${r.from}"  ->  "${r.to}"      [${r.source}] ${r.reason}`);
    }
  } else {
    out.push('  Proposed change: none — nothing here is safely repairable.');
  }

  out.push('');
  out.push('  Unchanged, and asserted so:');
  out.push('    steps, checkpoints, outcomes, inputs, outputs, risk policy, entry surface');

  if (proposal.refused.length) {
    out.push('');
    out.push('  Refused:');
    for (const r of proposal.refused) {
      out.push(`    ! ${r.stepId} (${r.kind}) — ${r.why}`);
    }
  }

  out.push('');
  out.push(`  Model calls: ${proposal.modelCalls}${proposal.modelCalls === 0 ? ' — every rename was resolved deterministically' : ''}`);

  if (problems.length) {
    out.push('');
    out.push('  REJECTED:');
    for (const p of problems) out.push(`    - ${p}`);
  } else if (patched) {
    out.push('');
    out.push(`  Written as v${patched.version}, approval=draft, hash ${patched.provenance.contentHash}`);
    out.push('  Nothing runs against it until a human approves it:');
    out.push(`    npx tsx src/cli.ts approve -c ${patched.id} -r <you> -n "reviewed repair proposal"`);
  }

  out.push('');
  return out.join('\n');
}
