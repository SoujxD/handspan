/**
 * Escalation — detecting "stuck" and routing a human to the live session.
 *
 * Three distinct things get conflated in most designs, so they are separate
 * here:
 *
 *   DETECTION  — deciding a run cannot safely continue. Four triggers, below.
 *   ROUTING    — packaging enough context that a person can act without
 *                reading the source: which capability, which step, why it
 *                stopped, what the screen looked like, what they should do.
 *   TRANSFER   — actually moving control of the live browser session, which is
 *                the SessionLease's job, not this module's.
 *
 * The detection triggers are deliberately explicit rather than "if something
 * goes wrong". A run escalates when, and only when:
 *
 *   1. An `escalate`-classified outcome rule fires (declared in the artifact).
 *   2. Policy blocks an irreversible action — a person must decide.
 *   3. A recoverable condition exhausts its recovery budget.
 *   4. Discovery makes no forward progress for N consecutive steps.
 *
 * Everything else is a business outcome or a hard failure. Escalation is
 * expensive — it consumes a human — so the bar is "a person could fix this and
 * software cannot", not "an error happened".
 */

import { randomUUID } from 'node:crypto';
import type { SessionLease } from './lease.js';

export type EscalationTrigger =
  | 'declared_outcome'
  | 'policy_blocked_irreversible'
  | 'recovery_exhausted'
  | 'no_progress'
  | 'manual';

export interface HumanAction {
  at: string;
  type: 'click' | 'input' | 'change' | 'submit' | 'navigate' | 'note';
  /** Semantic description of the target, same vocabulary as UiNode. */
  target?: string;
  role?: string;
  label?: string;
  /** Redacted before storage. Never the raw keystrokes of a password field. */
  value?: string;
  url?: string;
}

export interface Intervention {
  id: string;
  createdAt: string;
  runId: string;
  capabilityId: string;
  capabilityName: string;
  tenantId: string;
  goal: string;

  trigger: EscalationTrigger;
  /** One line an on-call human reads first. */
  reason: string;
  /** What we want them to actually do. */
  guidance: string;

  atStepId: string | null;
  stepIntent: string | null;
  currentUrl: string;

  /** Evidence paths, relative to the run's evidence directory. */
  screenshotPath?: string;
  snapshotPath?: string;

  status: 'open' | 'in_progress' | 'handed_back' | 'aborted' | 'resolved';
  operatorId?: string;
  /** Everything the human did while holding the lease. */
  humanActions: HumanAction[];
  resolutionNote?: string;
  closedAt?: string;
}

/**
 * In-memory broker.
 *
 * Deliberately not a queue/database: the brief explicitly says not to build
 * scaling infrastructure. The seam is the interface — swapping this for a
 * durable queue means implementing `create`/`get`/`list`/`update` against a
 * table, and nothing above it changes. What is real here is the state machine
 * and its coupling to the lease, which is the part that is hard to get right.
 */
export class EscalationBroker {
  private readonly items = new Map<string, Intervention>();
  private readonly leases = new Map<string, SessionLease>();
  private readonly screenshotProviders = new Map<string, () => Promise<Buffer>>();

  create(
    input: Omit<Intervention, 'id' | 'createdAt' | 'status' | 'humanActions'>,
    lease: SessionLease,
    screenshotProvider: () => Promise<Buffer>,
  ): Intervention {
    const id = `INT-${randomUUID().slice(0, 8).toUpperCase()}`;
    const item: Intervention = {
      ...input,
      id,
      createdAt: new Date().toISOString(),
      status: 'open',
      humanActions: [],
    };
    this.items.set(id, item);
    this.leases.set(id, lease);
    this.screenshotProviders.set(id, screenshotProvider);

    // Pause first, then publish. Publishing a session the automation still
    // holds would let an operator and the automation act simultaneously.
    lease.pause(input.reason, id);
    return item;
  }

  get(id: string): Intervention | undefined {
    return this.items.get(id);
  }

  list(): Intervention[] {
    return [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  leaseFor(id: string): SessionLease | undefined {
    return this.leases.get(id);
  }

  async liveScreenshot(id: string): Promise<Buffer | undefined> {
    const p = this.screenshotProviders.get(id);
    if (!p) return undefined;
    try {
      return await p();
    } catch {
      return undefined;
    }
  }

  /** Operator takes control of the live session. */
  takeControl(id: string, operatorId: string): Intervention {
    const item = this.mustGet(id);
    const lease = this.leases.get(id);
    if (!lease) throw new Error(`No live session bound to ${id}.`);
    lease.grantToOperator(operatorId);
    item.status = 'in_progress';
    item.operatorId = operatorId;
    return item;
  }

  recordHumanAction(id: string, action: HumanAction): void {
    const item = this.items.get(id);
    if (!item) return;
    // Bounded so a long manual session can't grow unbounded in memory.
    if (item.humanActions.length < 500) item.humanActions.push(action);
  }

  /** Operator is finished; automation may resume. */
  handBack(id: string, note: string): Intervention {
    const item = this.mustGet(id);
    const lease = this.leases.get(id);
    if (!lease) throw new Error(`No live session bound to ${id}.`);
    lease.handBack(note);
    item.status = 'handed_back';
    item.resolutionNote = note;
    return item;
  }

  /** Operator judges the run should not continue. */
  abort(id: string, note: string): Intervention {
    const item = this.mustGet(id);
    const lease = this.leases.get(id);
    if (lease && lease.isHeldBy('operator')) lease.handBack(`aborted: ${note}`);
    item.status = 'aborted';
    item.resolutionNote = note;
    item.closedAt = new Date().toISOString();
    return item;
  }

  markResolved(id: string, note: string): void {
    const item = this.items.get(id);
    if (!item) return;
    item.status = 'resolved';
    item.resolutionNote = item.resolutionNote ?? note;
    item.closedAt = new Date().toISOString();
  }

  private mustGet(id: string): Intervention {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unknown intervention: ${id}`);
    return item;
  }
}

/** Process-wide broker so the operator console and the run share state. */
export const broker = new EscalationBroker();
