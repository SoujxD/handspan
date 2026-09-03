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

import type Anthropic from '@anthropic-ai/sdk';
import type { PolicyEngine } from '../safety/policy.js';
import type { Redactor } from '../safety/redaction.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';
import type { Surface, SurfaceSnapshot, UiNode } from '../types/surface.js';
import type { RiskClass } from '../types/artifact.js';
import { anthropicClient } from '../config.js';
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
  /**
   * A side trip taken to observe an alternative outcome screen, not part of
   * the task. Executed and kept in the trace as evidence, but excluded from
   * the compiled steps — otherwise asking the model to go and look at the
   * "no such member" page bakes that detour into the capability.
   */
  exploratory?: boolean;
  risk: RiskClass;
  /**
   * Post-action page state, used to synthesise checkpoints.
   *
   * `chrome` and `data` are separated deliberately. Chrome is structural — the
   * panel titles and field labels that are the same for every record. Data is
   * the record itself. A checkpoint built from chrome ("Share Accounts")
   * survives a different member; one built from data ("Whitfield, Dana") is a
   * recording of one run masquerading as a reusable capability, and fails the
   * first time a caller passes a different id.
   */
  after?: {
    url: string;
    title: string;
    textExcerpt: string;
    chrome: string[];
    data: string[];
  };
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
  /**
   * The screen as it was before any step ran.
   *
   * Two uses, both of which turned out to matter. It is the text baseline for
   * the FIRST action — without it every phrase on the opening screen looks
   * "novel" and the compiler builds a nonsense checkpoint out of the first
   * short line it sees. And it is what lets the compiler reject an outcome rule
   * whose detector is already true at the entry point, which would otherwise
   * fire on every single run.
   */
  entryState: { url: string; text: string };
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
  const client = anthropicClient();

  const trace: DiscoveryTrace = {
    goal,
    entryUrl,
    tenantId,
    actions: [],
    notes: [],
    entryState: { url: '', text: '' },
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
  trace.entryState = { url: snapshot.url, text: snapshot.text };
  evidence.saveSnapshot('entry', snapshot);
  evidence.saveScreenshot('entry', await surface.screenshot());

  /**
   * The environment header travels with the goal, not just in the system
   * prompt.
   *
   * A goal like "log in as teller01 and read a member's balance" describes,
   * out of context, something a model should refuse: signing in to a financial
   * institution's console and reading a customer's account. The context that
   * makes it ordinary — a mock app on localhost, synthetic records, fixture
   * credentials the caller already holds — belongs next to the request itself,
   * which is where a human reviewer would expect to find it too.
   */
  const environment =
    `## Environment\n\n` +
    `Target: ${entryUrl}\n` +
    `A mock back-office servicing console running locally as part of this project. ` +
    `Every member record is a synthetic fixture and the sign-in credentials are test ` +
    `values declared as parameters of the capability being recorded. No real institution, ` +
    `customer, or credential is involved.\n\n`;

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `${environment}## Goal\n\n${goal}\n\n## Institution\n\n${tenantId}\n\n${renderObservation(
        toObservation(snapshot, maxSteps),
      )}`,
    },
  ];

  /** Counts turns where the model produced no tool call at all — a real stall. */
  let noProgress = 0;
  /** Counts consecutive identical actions — a real loop. */
  let repeatedAction = 0;
  /** One warning is spent before a suspected loop ends the run. */
  let loopNudged = false;
  /** Text to append to the next tool-result turn, if the loop guard fired. */
  let pendingNudge = '';
  let lastActionSignature = '';
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
      response = await withTransientRetry(
        () =>
          client.messages.create({
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
          } as unknown as Anthropic.MessageCreateParamsNonStreaming),
        (attempt, waitMs, reason) =>
          evidence.warn('model_call_retrying', { step, attempt, waitMs, reason }),
      );
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
        exploratory: input['exploratory'] === true,
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
        chrome: uniqueStrings(
          snapshot.nodes.flatMap((n) => [n.container ?? '', n.label ?? '', n.columnHeader ?? '']),
        ),
        data: uniqueStrings(snapshot.nodes.map((n) => n.value ?? '')),
      };
      trace.actions.push(action);

      evidence.info('action_executed', {
        tool: use.name,
        intent,
        exploratory: action.exploratory ?? false,
        risk: decision.risk,
        target: node ? `${node.role} "${node.label || node.name}"` : action.navigateUrl,
        url: snapshot.url,
      });
      // Evidence capture must never be able to end a run. A screenshot can
      // fail for reasons that have nothing to do with the flow — a frame
      // detaching mid-capture, or the browser window being closed — and losing
      // a whole discovery run because one PNG could not be written would be an
      // expensive way to find that out.
      try {
        evidence.saveScreenshot(`step-${action.index}-${use.name}`, await surface.screenshot());
      } catch (e) {
        evidence.warn('screenshot_failed', { step: action.index, error: (e as Error).message });
      }

      results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Done. Fresh observation below.' });
    }

    if (terminate) {
      trace.stoppedBecause = terminate;
      break;
    }

    // Progress heuristic.
    //
    // NOT "the URL stopped changing" — that punishes the model for doing the
    // things this system most wants it to do. Typing into a field never
    // changes the URL, and neither does `record_note`, which is how the
    // unhappy paths get captured at all. An early version used the URL and
    // killed a run that had completed the whole flow and was part-way through
    // documenting its business outcomes.
    //
    // What actually indicates a stuck run is repetition: the same tool against
    // the same target with the same value, over and over. That is checked
    // below. The real bounds on a runaway run are the step budget and the wall
    // clock, both of which are hard.
    /**
     * Identify a repeat semantically, and only where the screen agrees.
     *
     * The obvious signature — tool plus element handle — is wrong in both
     * directions, because handles are reissued on every observation. The same
     * handle on two different screens looks like a repeat when it is not, and
     * this cost a completed 18-action run: the model returned to the home page
     * after each of three probes, drew `e11` for the nav link every time, and
     * was killed for looping one turn before it called `finish`. Conversely a
     * genuine loop can renumber and slip past.
     *
     * So the signature is the semantic description of what was acted on, and
     * the URL is part of it. A repeat that moves the app somewhere new is
     * progress, whatever it looks like.
     */
    const last = trace.actions[trace.actions.length - 1];
    const signature = last
      ? [
          last.tool,
          last.node ? `${last.node.role}:${last.node.label || last.node.name}@${last.node.container ?? ''}` : '',
          last.navigateUrl ?? '',
          last.value ?? '',
          snapshot.url,
        ].join('|')
      : '';

    if (signature && signature === lastActionSignature) {
      repeatedAction++;
      if (repeatedAction >= policy.limits.maxConsecutiveNoProgress) {
        evidence.warn('discovery_looping', { signature, consecutive: repeatedAction, url: snapshot.url });

        // Nudge before killing. A run that has done the work and is circling
        // is worth one sentence; killing it throws away every turn before it.
        if (loopNudged) {
          trace.stoppedBecause = 'no_progress';
          break;
        }
        loopNudged = true;
        repeatedAction = 0;
        // Carried into the turn that delivers this step's tool results. It
        // cannot be pushed as its own message: the assistant's `tool_use`
        // blocks are still unanswered at this point, and a bare user turn
        // between them and their results is a malformed request.
        pendingNudge =
          'You have repeated the same action on the same screen several times with no change. ' +
          'If the goal state is already on screen, call `finish` now with the contract. ' +
          'If you are stuck, call `escalate`. Do not repeat that action again.';
      }
    } else {
      repeatedAction = 0;
    }
    lastActionSignature = signature;
    lastUrl = snapshot.url;

    // Tool results and the fresh observation go back in a single user turn, so
    // the model always decides against the screen as it is *now*.
    messages.push({
      role: 'user',
      content: [
        ...results,
        { type: 'text', text: renderObservation(toObservation(snapshot, maxSteps - step - 1)) },
        ...(pendingNudge ? [{ type: 'text' as const, text: pendingNudge }] : []),
      ],
    });
    pendingNudge = '';
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

/** Short, de-duplicated, non-empty strings. Bounded so a trace stays small. */
function uniqueStrings(values: string[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    const t = v.trim();
    if (t.length >= 3 && t.length <= 80) out.add(t);
    if (out.size >= 250) break;
  }
  return [...out];
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

/**
 * Retry a model call through transient infrastructure failures.
 *
 * A discovery run is a long conversation, and losing it to a single 529
 * "overloaded" on turn nine throws away every turn before it — the run is not
 * resumable, so the cost of one transient failure is the whole run, not one
 * request. That asymmetry is what justifies retrying here and nowhere else in
 * the system.
 *
 * Deliberately narrow. Only status codes that mean "try again" are retried:
 * 408, 409, 429 and 5xx. A 400 is a malformed request and a 401 is a bad key —
 * both will fail identically forever, and retrying them just burns wall clock
 * on the way to the same error message. A `refusal` never reaches here at all,
 * because it arrives as a successful response with a stop reason, and retrying
 * it would be asking the same question again hoping for a different answer.
 *
 * Failed requests are not billed, so the retries are free; the backoff exists
 * to be a good citizen of a service that has just said it is overloaded.
 */
export async function withTransientRetry<T>(
  call: () => Promise<T>,
  onRetry: (attempt: number, waitMs: number, reason: string) => void,
  // Six attempts spans roughly half a minute of backoff. Tuned for the cost
  // asymmetry: half a minute of waiting is cheap, and a discovery run thrown
  // away nine turns in is not.
  maxAttempts = 6,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await call();
    } catch (e) {
      lastError = e;
      if (attempt === maxAttempts || !isTransient(e)) throw e;

      // Exponential backoff with jitter: 1s, 2s, 4s ± 25%. Jitter matters
      // because an overload is usually shared — synchronized retries from
      // every client are what turn a blip into an outage.
      const base = 1000 * 2 ** (attempt - 1);
      const waitMs = Math.round(base * (0.75 + Math.random() * 0.5));
      onRetry(attempt, waitMs, (e as Error).message.slice(0, 120));
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  throw lastError;
}

function isTransient(e: unknown): boolean {
  const status = (e as { status?: number }).status;
  if (typeof status === 'number') return status === 408 || status === 409 || status === 429 || status >= 500;

  // No status: a socket-level failure that never reached the service.
  const code = (e as { code?: string }).code ?? '';
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
}
