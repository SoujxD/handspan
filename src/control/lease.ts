/**
 * Session lease — the control-transfer model.
 *
 * The brief asks who is (or should be) in control of a live session. The answer
 * here is a single-holder lease that every mutating surface call must check.
 * It is not advisory: `PlaywrightSurface.act()` calls `assertHeldBy('automation')`
 * before it touches the page, so while an operator holds the lease the
 * automation *cannot* act, even if a bug tried to. Control transfer is a state
 * machine with an enforcement point, not a convention.
 *
 *   automation --pause--> paused --grant--> operator --handBack--> paused
 *        ^                                                          |
 *        +----------------------- resume ---------------------------+
 *
 * `paused` is a distinct state on purpose. It is the moment where nobody holds
 * the lease: the automation has stopped and the human has not yet picked it up.
 * Without it, a handoff has a window where both sides believe they are driving.
 *
 * The browser session itself is never torn down across any of these
 * transitions. The operator drives the *same* page, with the same cookies,
 * same frame state, same half-filled form.
 */

export type Holder = 'automation' | 'operator' | 'nobody';

export type LeaseState =
  | { status: 'automation'; since: string }
  | { status: 'paused'; since: string; reason: string; interventionId: string }
  | { status: 'operator'; since: string; operatorId: string; interventionId: string }
  | { status: 'closed'; since: string };

export interface LeaseEvent {
  at: string;
  from: Holder;
  to: Holder;
  reason: string;
  interventionId?: string;
  operatorId?: string;
}

export class ControlDeniedError extends Error {
  constructor(
    readonly attemptedBy: Holder,
    readonly currentHolder: Holder,
  ) {
    super(
      `Control denied: ${attemptedBy} attempted to act on the session but ${currentHolder} holds the lease.`,
    );
    this.name = 'ControlDeniedError';
  }
}

export class SessionLease {
  private state: LeaseState = { status: 'automation', since: new Date().toISOString() };
  private readonly log: LeaseEvent[] = [];
  private waiters: Array<() => void> = [];

  constructor(readonly sessionId: string) {
    this.log.push({ at: this.state.since, from: 'nobody', to: 'automation', reason: 'session started' });
  }

  get current(): LeaseState {
    return this.state;
  }

  get holder(): Holder {
    switch (this.state.status) {
      case 'automation':
        return 'automation';
      case 'operator':
        return 'operator';
      default:
        return 'nobody';
    }
  }

  get history(): readonly LeaseEvent[] {
    return this.log;
  }

  /**
   * The enforcement point. Every mutating surface call routes through here.
   * Read-only calls (snapshot, screenshot) deliberately do NOT — the harness
   * must keep observing and capturing evidence while the human works, which is
   * how we record what the operator did.
   */
  assertHeldBy(who: Holder): void {
    if (this.holder !== who) throw new ControlDeniedError(who, this.holder);
  }

  isHeldBy(who: Holder): boolean {
    return this.holder === who;
  }

  /** Automation cedes control. Nobody drives until an operator takes it. */
  pause(reason: string, interventionId: string): void {
    if (this.state.status === 'closed') throw new Error('Session is closed.');
    const from = this.holder;
    this.state = { status: 'paused', since: new Date().toISOString(), reason, interventionId };
    this.log.push({ at: this.state.since, from, to: 'nobody', reason, interventionId });
  }

  /** A human picks up a paused session. */
  grantToOperator(operatorId: string): void {
    if (this.state.status !== 'paused') {
      throw new Error(`Cannot grant control from state "${this.state.status}"; session must be paused.`);
    }
    const interventionId = this.state.interventionId;
    this.state = { status: 'operator', since: new Date().toISOString(), operatorId, interventionId };
    this.log.push({
      at: this.state.since,
      from: 'nobody',
      to: 'operator',
      reason: 'operator took control',
      interventionId,
      operatorId,
    });
  }

  /** The human is done. Back to paused, awaiting the automation's decision. */
  handBack(note: string): void {
    if (this.state.status !== 'operator') {
      throw new Error(`Cannot hand back from state "${this.state.status}".`);
    }
    const interventionId = this.state.interventionId;
    const operatorId = this.state.operatorId;
    this.state = { status: 'paused', since: new Date().toISOString(), reason: note, interventionId };
    this.log.push({
      at: this.state.since,
      from: 'operator',
      to: 'nobody',
      reason: `operator handed back: ${note}`,
      interventionId,
      operatorId,
    });
    this.wake();
  }

  /** Automation resumes. Only legal from `paused`. */
  resume(reason: string): void {
    if (this.state.status !== 'paused') {
      throw new Error(`Cannot resume from state "${this.state.status}".`);
    }
    this.state = { status: 'automation', since: new Date().toISOString() };
    this.log.push({ at: this.state.since, from: 'nobody', to: 'automation', reason });
    this.wake();
  }

  close(): void {
    const from = this.holder;
    this.state = { status: 'closed', since: new Date().toISOString() };
    this.log.push({ at: this.state.since, from, to: 'nobody', reason: 'session closed' });
    this.wake();
  }

  /**
   * Block until the operator is finished (or the session dies).
   *
   * Resolves on any transition out of `operator`, so an abort and a normal
   * hand-back both unblock the caller; the caller then inspects state to see
   * which happened. Polls on a timer as well as on events so a crashed console
   * cannot wedge a run forever.
   */
  async waitForHandBack(timeoutMs: number): Promise<'handed_back' | 'timeout' | 'closed'> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      if (this.state.status === 'closed') return 'closed';
      if (this.state.status === 'paused' && this.log.some((e) => e.from === 'operator')) {
        return 'handed_back';
      }
      if (Date.now() > deadline) return 'timeout';

      await new Promise<void>((resolveWait) => {
        const t = setTimeout(resolveWait, 500);
        this.waiters.push(() => {
          clearTimeout(t);
          resolveWait();
        });
      });
    }
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
}
