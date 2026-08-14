/**
 * The discovery loop: observe -> decide -> act, with Claude driving.
 *
 * Written as an explicit loop rather than with the SDK's tool runner, for one
 * reason that is specific to this problem: every proposed action has to pass
 * through the policy engine *and* be recorded into a structured trace before it
 * reaches the surface, and a denial has to come back to the model as a normal
 * tool result it can reason about rather than as a thrown error. That
 * intercept-classify-record-execute-observe sequence is the substance of the
 * system, so it lives in code we own and can point at in review.
 *
 * The loop is also where the "the model discovers, the artifact executes" split
 * is made concrete. Nothing here writes an artifact — it produces a
 * `DiscoveryTrace`, and `compiler.ts` turns that into a capability. Keeping
 * them separate means the compiler's invariants (no unverified state changes,
 * no literal credentials, no retries on irreversible steps) are enforced
 * against the trace rather than trusted to the model's good behaviour.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { PolicyEngine } from '../safety/policy.js';
import type { Redactor } from '../safety/redaction.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';
import type { Surface, SurfaceSnapshot, UiNode } from '../types/surface.js';
import type { RiskClass } from '../types/artifact.js';
import { TOOLS } from './tools.js';
import { renderObservation, systemPrompt } from './prompt.js';

export interface DiscoveryAction {
  index: number;
  tool: string;
  intent: string;
  /** The node acted on, captured from the snapshot at action time. */
  node?: UiNode;
  /** All nodes visible then — the compiler needs them to test uniqueness. */
  siblings?: UiNode[];
  url: string;
  value?: string;
  /** Set when the model bound this value to a named input parameter. */
  parameterName?: string;
  navigateUrl?: string;
  risk: RiskClass;
  /** Post-action page state, used to synthesise checkpoints. */
  after?: { url: string; title: string; textExcerpt: string };
  denied?: { reason: string; remediation: string };
}

export interface DiscoveryNote {
  kind: 'business_outcome' | 'recoverable_condition' | 'validation_rule' | 'observation';
  note: string;
  atUrl: string;
}

/** Raw `finish` payload. Shape-checked by the compiler, not here. */
export type FinishPayload = Record<string, unknown>;

export interface DiscoveryTrace {
  goal: string;
  entryUrl: string;
  tenantId: string;
  actions: DiscoveryAction[];
  notes: DiscoveryNote[];
  finish?: FinishPayload;
  escalation?: { reason: string; guidance: string };
  stoppedBecause: 'finished' | 'escalated' | 'budget_exhausted' | 'no_progress' | 'model_refusal' | 'error';
  llmCalls: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

export interface DiscoveryDeps {
  surface: Surface;
  policy: PolicyEngine;
  redactor: Redactor;
  evidence: EvidenceRecorder;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Called when the model escalates, so the caller can raise an intervention. */
  onEscalate?: (reason: string, guidance: string) => Promise<void>;
}

export async function runDiscovery(
  goal: string,
  entryUrl: string,
  tenantId: string,
  deps: DiscoveryDeps,
): Promise<DiscoveryTrace> {
  const { surface, policy, redactor, evidence } = deps;
  const client = new Anthropic();

  const trace: DiscoveryTrace = {
    goal,
    entryUrl,
    tenantId,
    actions: [],
    notes: [],
    stoppedBecause: 'error',
    llmCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  };

  const maxSteps = policy.limits.maxStepsPerDiscovery;
  const deadline = Date.now() + policy.limits.maxWallClockMsPerDiscovery;

  // Open the flow ourselves rather than asking the model to. The entry point is
  // caller-supplied and policy-checked, so there is no reason to spend a model
  // turn on it — and it guarantees the first observation is of the right app.
  const entryDecision = policy.checkNavigation(entryUrl);
  if (!entryDecision.allow) {
    evidence.error('entry_url_denied', { url: entryUrl, reason: entryDecision.reason });
    throw new Error(`Entry URL denied by policy: ${entryDecision.reason}`);
  }
  await surface.act({ kind: 'navigate', url: entryUrl });

  let snapshot = await surface.snapshot();
  evidence.saveSnapshot('entry', snapshot);
  evidence.saveScreenshot('entry', await surface.screenshot());

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `## Goal\n\n${goal}\n\n## Institution\n\n${tenantId}\n\n${renderObservation(
        toObservation(snapshot, maxSteps),
      )}`,
    },
  ];

  let noProgress = 0;
  let lastUrl = snapshot.url;

  for (let step = 0; step < maxSteps; step++) {
    if (Date.now() > deadline) {
      trace.stoppedBecause = 'budget_exhausted';
      evidence.warn('discovery_wallclock_exhausted', { step });
      break;
    }

    let response: Anthropic.Message;
    try {
      // `thinking: adaptive` and `output_config.effort` are current API
      // parameters whose typings lag in this SDK release, so the request body
      // is asserted rather than left implicit. Stated explicitly rather than
      // omitted: on Opus 5 omitting `thinking` happens to run adaptive anyway,
      // but on Opus 4.8 it means *no* thinking — and this model id is
      // configurable, so relying on a per-model default would be a latent bug.
      response = await client.messages.create({
        model: deps.model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: deps.effort },
        system: [
          {
            type: 'text',
            text: systemPrompt(),
            // Stable prefix; everything volatile lives after it in `messages`.
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: TOOLS,
        messages,
      } as unknown as Anthropic.MessageCreateParamsNonStreaming);
    } catch (e) {
      const err = e as Error;
      evidence.error('model_call_failed', { error: err.message, step });
      trace.stoppedBecause = 'error';
      throw err;
    }

    trace.llmCalls++;
    trace.usage.inputTokens += response.usage.input_tokens;
    trace.usage.outputTokens += response.usage.output_tokens;
    trace.usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;

    if (response.stop_reason === 'refusal') {
      evidence.error('model_refusal', {
        details: (response as unknown as { stop_details?: unknown }).stop_details ?? null,
      });
      trace.stoppedBecause = 'model_refusal';
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    const said = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();
    if (said) evidence.debug('model_said', { text: said.slice(0, 400) });

    if (toolUses.length === 0) {
      // No tool call and no finish: the model has stalled. One nudge, then stop.
      evidence.warn('model_made_no_tool_call', { step });
      noProgress++;
      if (noProgress >= policy.limits.maxConsecutiveNoProgress) {
        trace.stoppedBecause = 'no_progress';
        break;
      }
      messages.push({
        role: 'user',
        content:
          'You did not take an action. Either act on the current screen, call `finish` if the goal state is ' +
          'already reached, or call `escalate` if you cannot proceed safely.',
      });
      continue;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let terminate: DiscoveryTrace['stoppedBecause'] | null = null;

    for (const use of toolUses) {
      const input = (use.input ?? {}) as Record<string, unknown>;
      const intent = String(input['intent'] ?? input['reason'] ?? use.name);

      // ---- terminal tools -------------------------------------------------
      if (use.name === 'finish') {
        trace.finish = input;
        terminate = 'finished';
        evidence.info('model_finished', { capabilityId: input['capabilityId'] });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Recorded. Run complete.' });
        continue;
      }

      if (use.name === 'escalate') {
        const reason = String(input['reason'] ?? 'model requested help');
        const guidance = String(input['guidance'] ?? 'Complete the step manually, then hand control back.');
        trace.escalation = { reason, guidance };
        terminate = 'escalated';
        evidence.warn('model_escalated', { reason, guidance });
        await deps.onEscalate?.(reason, guidance);
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Escalated to a human operator.' });
        continue;
      }

      if (use.name === 'record_note') {
        const note: DiscoveryNote = {
          kind: (String(input['kind'] ?? 'observation') as DiscoveryNote['kind']),
          note: String(input['note'] ?? ''),
          atUrl: snapshot.url,
        };
        trace.notes.push(note);
        evidence.info('note_recorded', { kind: note.kind, note: note.note.slice(0, 200) });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Noted.' });
        continue;
      }

      if (use.name === 'observe') {
        snapshot = await surface.snapshot();
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Re-read. Fresh observation below.' });
        continue;
      }

      // ---- acting tools ---------------------------------------------------
      const handle = typeof input['handle'] === 'string' ? input['handle'] : undefined;
      const node = handle ? snapshot.nodes.find((n) => n.handle === handle) : undefined;

      if (handle && !node) {
        // Stale or invented handle. Told plainly so the model re-reads rather
        // than guessing at another one.
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: `Handle "${handle}" is not in the current observation. Handles are reissued every time the screen is read; use one from the observation below.`,
        });
        continue;
      }

      const intentForPolicy = {
        kind: toPolicyKind(use.name),
        url: typeof input['url'] === 'string' ? input['url'] : undefined,
        targetName: node?.name || node?.label,
        targetContainer: node?.container,
        fieldLabel: node?.label,
      } as const;

      const decision = policy.evaluate(intentForPolicy, {
        mode: 'attended',
        capabilityId: 'discovery',
      });

      const action: DiscoveryAction = {
        index: trace.actions.length,
        tool: use.name,
        intent,
        node,
        siblings: snapshot.nodes,
        url: snapshot.url,
        risk: decision.risk,
      };

      if (!decision.allow) {
        action.denied = { reason: decision.reason, remediation: decision.remediation };
        trace.actions.push(action);
        evidence.warn('action_denied_by_policy', {
          tool: use.name,
          target: intentForPolicy.targetName,
          reason: decision.reason,
          risk: decision.risk,
        });
        // The denial goes back as a normal result. The model needs to reason
        // about the constraint, not be crashed by it.
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: `Refused by policy: ${decision.reason}\n${decision.remediation}\nDo not attempt an alternative route to the same action. Adapt the plan or escalate.`,
        });
        continue;
      }

      try {
        switch (use.name) {
          case 'navigate': {
            const url = String(input['url']);
            action.navigateUrl = url;
            await surface.act({ kind: 'navigate', url });
            break;
          }
          case 'click': {
            await surface.act({ kind: 'click', handle: handle! });
            break;
          }
          case 'type_text': {
            const text = String(input['text'] ?? '');
            const param = typeof input['parameter'] === 'string' ? input['parameter'] : undefined;
            action.value = text;
            action.parameterName = param;
            // A value typed into a field we classify as sensitive is registered
            // for exact scrubbing before it can reach any log line.
            if (decision.risk === 'sensitive') redactor.registerSecret(text);
            await surface.act({ kind: 'type', handle: handle!, text, clearFirst: true });
            break;
          }
          case 'select_option': {
            const value = String(input['value'] ?? '');
            action.value = value;
            action.parameterName = typeof input['parameter'] === 'string' ? input['parameter'] : undefined;
            await surface.act({ kind: 'select', handle: handle!, value });
            break;
          }
          default: {
            results.push({
              type: 'tool_result',
              tool_use_id: use.id,
              is_error: true,
              content: `Unknown tool "${use.name}".`,
            });
            continue;
          }
        }
      } catch (e) {
        const msg = (e as Error).message;
        evidence.warn('action_failed', { tool: use.name, intent, error: msg });
        action.denied = { reason: msg, remediation: 'The action did not complete; re-read the screen.' };
        trace.actions.push(action);
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: `The action failed: ${msg}`,
        });
        continue;
      }

      snapshot = await surface.snapshot();
      action.after = {
        url: snapshot.url,
        title: snapshot.title,
        textExcerpt: snapshot.text.slice(0, 1500),
      };
      trace.actions.push(action);

      evidence.info('action_executed', {
        tool: use.name,
        intent,
        risk: decision.risk,
        target: node ? `${node.role} "${node.label || node.name}"` : action.navigateUrl,
        url: snapshot.url,
      });
      evidence.saveScreenshot(`step-${action.index}-${use.name}`, await surface.screenshot());

      results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Done. Fresh observation below.' });
    }

    if (terminate) {
      trace.stoppedBecause = terminate;
      break;
    }

    // Progress heuristic: a run that has not changed URL for several actions is
    // circling. This is one of the four escalation triggers.
    if (snapshot.url === lastUrl) noProgress++;
    else noProgress = 0;
    lastUrl = snapshot.url;

    if (noProgress >= policy.limits.maxConsecutiveNoProgress + 2) {
      evidence.warn('discovery_no_progress', { url: snapshot.url, consecutive: noProgress });
      trace.stoppedBecause = 'no_progress';
      break;
    }

    // Tool results and the fresh observation go back in a single user turn, so
    // the model always decides against the screen as it is *now*.
    messages.push({
      role: 'user',
      content: [
        ...results,
        { type: 'text', text: renderObservation(toObservation(snapshot, maxSteps - step - 1)) },
      ],
    });
  }

  if (trace.stoppedBecause === 'error' && trace.actions.length > 0) {
    trace.stoppedBecause = 'budget_exhausted';
  }

  evidence.info('discovery_complete', {
    stoppedBecause: trace.stoppedBecause,
    actions: trace.actions.length,
    notes: trace.notes.length,
    llmCalls: trace.llmCalls,
    usage: trace.usage,
  });

  return trace;
}

function toObservation(snapshot: SurfaceSnapshot, budget: number) {
  return {
    url: snapshot.url,
    title: snapshot.title,
    text: snapshot.text,
    stepBudgetRemaining: Math.max(0, budget),
    nodes: snapshot.nodes.map((n) => ({
      handle: n.handle,
      role: n.role,
      name: n.name,
      label: n.label,
      labelSource: n.labelSource,
      value: n.value,
      container: n.container,
      framePath: n.framePath,
      enabled: n.enabled,
    })),
  };
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
