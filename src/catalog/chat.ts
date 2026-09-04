/**
 * The chatbot — a conversational front door over the capability API.
 *
 * It is deliberately not an agent. It does exactly two things: choose a
 * capability and bind typed arguments to it. It cannot invent a step, cannot
 * touch a browser, cannot reach anything except this API, and the tool list it
 * is given is the catalog's own projection — so the set of things it can
 * possibly do is the set of things a human already reviewed and approved.
 *
 * Two decisions worth defending:
 *
 * 1. THE MODEL NEVER AUTHORISES A COMMIT. For a `confirmable` capability the
 *    bot stops, restates the transaction in plain language, and waits. The
 *    confirmation token is minted from the *user's* click, in code, on the
 *    turn after. A model must not be the thing that authorises moving money,
 *    and the way to guarantee that is to make it structurally impossible
 *    rather than to instruct it not to.
 *
 * 2. IT NEVER SEES A CREDENTIAL. Secret inputs are stripped from the tool
 *    schema entirely, so there is nothing for the model to bind and nothing to
 *    land in a transcript. The server fills them from its own environment.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { anthropicClient, boundInputNames, runtimeConfig } from '../config.js';
import { toToolDefinition, type CapabilityStore } from './store.js';
import type { ReplayResult } from '../types/result.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type ChatReply =
  /** Plain conversational answer; nothing was invoked. */
  | { type: 'say'; text: string; modelCalls: number }
  /** A commit is proposed and needs the HUMAN to authorise it. */
  | {
      type: 'confirm';
      text: string;
      capabilityId: string;
      tenantId: string;
      args: Record<string, string>;
      modelCalls: number;
    }
  /** A capability was invoked; `result` is the untouched result contract. */
  | { type: 'invoked'; capabilityId: string; args: Record<string, string>; modelCalls: number };

const SYSTEM = `You are the front door to a bank back-office automation system.

You have one job: work out which capability answers the user's request, and bind its typed
arguments. You never describe how the underlying application works, because you do not know —
each capability is a recorded flow that a human reviewed and approved.

Rules you must follow:
- Call EXACTLY ONE capability, or none. Do not plan a sequence and do not chain calls.
- Every capability signs on for itself and completes the whole task end to end. You never need
  to call operator_sign_on first, and you never need to look a value up before acting on it.
  Their descriptions all begin "signs on to..." because each one really does.
- Only call a capability from your tool list. If none fits, say so plainly and name the closest.
- Never invent an argument. If a required argument is missing, ask for it in one short sentence.
- Never ask for or accept a password or credential. Those are supplied by the server from its
  own environment and are not yours to handle.
- Some capabilities commit money or change a member record. You do not authorise those. Call the
  tool as normal; the system will stop and ask the person before anything is committed.
- Member numbers on this system are six digits. Share ids look like 100234-S0001.
- Be brief. One or two sentences, no preamble, no bullet lists.`;

/**
 * Strip secrets from the schema the model sees.
 *
 * Not a prompt instruction — a structural one. There is no field for it to
 * fill, so a credential cannot enter the conversation even if the user pastes
 * one and asks it to use it.
 */
function toolsFor(store: CapabilityStore, product: string): Anthropic.Tool[] {
  return store
    .listLatest()
    .filter((c) => c.surface.product === product)
    .map((c) => {
      const def = toToolDefinition(c);
      // Secrets AND deployment-bound inputs are removed from the schema. The
      // model cannot bind a credential, and it cannot ask to act as a
      // different operator, because neither field exists as far as it knows.
      /**
       * Three classes of field are removed from the schema the model sees.
       *
       *   secrets        — nothing to bind, so a credential cannot enter a
       *                    transcript even if the user pastes one.
       *   bound inputs   — the operator identity is a property of the
       *                    deployment; the bot cannot ask to be a supervisor.
       *   `confirm`      — the authorisation token.
       *
       * The last one was visible, and the model duly filled it in: asked to
       * move money it produced `confirm: "member_funds_transfer_between_shares"`
       * alongside the arguments. The server ignored it and minted the token
       * from the human's click, so nothing was ever authorised by a model —
       * but a guarantee that depends on the caller ignoring a field the model
       * filled in is a guarantee waiting to be lost in a refactor. Now there
       * is no field, and authorisation is not expressible.
       */
      const secret = new Set([
        ...c.inputs.filter((i) => i.sensitivity === 'secret').map((i) => i.name),
        ...boundInputNames(),
        'confirm',
      ]);
      const properties: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(def.input_schema.properties)) {
        if (!secret.has(k)) properties[k] = v;
      }
      return {
        name: def.name,
        description:
          def.description +
          (def.handspan.requiresConfirmation
            ? ' — COMMITS STATE: the system will ask the person to confirm before this runs.'
            : ''),
        input_schema: {
          type: 'object' as const,
          properties,
          required: def.input_schema.required.filter((r) => !secret.has(r)),
        },
      };
    });
}

export async function chat(opts: {
  store: CapabilityStore;
  product: string;
  defaultTenantId: string;
  history: ChatTurn[];
  message: string;
}): Promise<ChatReply> {
  const client = anthropicClient();
  const cfg = runtimeConfig();
  const tools = toolsFor(opts.store, opts.product);

  const messages: Anthropic.MessageParam[] = [
    ...opts.history.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: opts.message },
  ];

  // Effort `medium`: this is a router, not a reasoner - the hard
  // thinking already happened at discovery time and is frozen in the artifact -
  // but choosing between seven flows that all begin "sign on and look up a
  // member" is not free, and getting it wrong sends money to the wrong place.
  // `thinking: adaptive` and `output_config.effort` are current API parameters
  // whose typings lag this SDK release, so the body is asserted, as in the
  // discovery loop.
  const response = await client.messages.create({
    model: cfg.model,
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    tools,
    /**
     * One capability per turn, enforced rather than requested.
     *
     * Asked to move money, the model returned three parallel calls: sign on,
     * read one share, read the other — a sensible plan for an agent, and the
     * wrong shape entirely for a router. Every capability already signs on and
     * completes on its own, so a chain is both unnecessary and a way for the
     * bot to assemble behaviour nobody recorded or approved. The prompt says
     * so; this makes it true.
     */
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    messages,
  } as unknown as Anthropic.MessageCreateParamsNonStreaming);

  const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (calls.length > 1) {
    // Belt to the brace above: if a future model ignores the flag, refuse
    // rather than silently running whichever call happened to come first.
    return {
      type: 'say',
      text:
        'I tried to plan a sequence of steps, which this system does not allow — each capability ' +
        'completes a whole task on its own. Ask me for one thing at a time.',
      modelCalls: 1,
    };
  }
  const call = calls[0];
  const said = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  if (!call) {
    return { type: 'say', text: said || 'I am not sure which capability that maps to.', modelCalls: 1 };
  }

  const raw = (call.input ?? {}) as Record<string, unknown>;
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'tenantId') continue;
    // Belt and braces: even if a future schema leaks it back, an
    // authorisation the model wrote is never carried forward.
    if (k === 'confirm') continue;
    if (v !== null && v !== undefined) args[k] = String(v);
  }
  const tenantId = String(raw['tenantId'] ?? opts.defaultTenantId);

  const cap = opts.store.load(call.name);
  if (cap.policy.requiresConfirmation) {
    return {
      type: 'confirm',
      text: said || `About to run ${cap.name}.`,
      capabilityId: cap.id,
      tenantId,
      args,
      modelCalls: 1,
    };
  }

  return { type: 'invoked', capabilityId: cap.id, args, modelCalls: 1 };
}

/**
 * Turn a result contract into a sentence a person can act on.
 *
 * Written in code, not by the model, for the same reason the confirmation is:
 * the four shapes mean different things and a caller must not be told an
 * escalation was a success because a model chose a friendlier word. A business
 * outcome reads as an answer, because it is one.
 */
export function describeResult(result: ReplayResult, capabilityName: string): string {
  switch (result.status) {
    case 'success': {
      /**
       * `redacted` means "scrubbed from everything this run persisted" - not
       * "withheld from you". The caller asked for the balance and gets the
       * balance; what must never happen is that value coming to rest in a log,
       * a screenshot or an artifact. Reading the flag the other way round hid
       * the answer from the person who asked for it.
       */
      const shown = Object.entries(result.outputs)
        .map(([k, v]) => `${k}: ${String(v.value)}${v.redacted ? ' (kept out of the run record)' : ''}`)
        .join(', ');
      return `Done — ${capabilityName}. ${shown}`;
    }
    case 'outcome':
      return (
        `${result.outcomeTitle}. That is an answer, not an error: the application ` +
        `reported it and the run completed cleanly (${result.outcome}).`
      );
    case 'escalated':
      return (
        `Stopped and handed this to a person. ${result.reason} ` +
        `What they need to do: ${result.guidance} The browser session is still open and parked ` +
        `for them (intervention ${result.interventionId}).`
      );
    case 'failure': {
      // A pre-flight rejection never reached the application, so describing
      // what was "expected on screen" would be fiction. Say what actually
      // happened instead.
      if (!result.failure.atStepId) {
        return `Could not run this. ${result.failure.message} ${result.failure.remediation ?? ''}`.trim();
      }
      return (
        `Could not complete this. ${result.failure.message} ` +
        `It stopped at step ${result.failure.atStepId}; it expected ` +
        `${result.failure.expected ?? 'a different screen'} and saw ` +
        `${result.failure.observed ?? 'something else'}. ${result.failure.remediation ?? ''}`
      ).trim();
    }
  }
}
