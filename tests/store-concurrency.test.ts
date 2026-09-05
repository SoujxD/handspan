/**
 * The stability counter is shared mutable state on disk.
 *
 * `governance.stability.runs` gates approval, and it is written by a
 * read-modify-write. Nothing about the demo runs one capability at a time: the
 * catalog serves concurrent HTTP invocations, and the script drives a CLI
 * replay in a second terminal while the catalog is up. Until this test existed
 * nothing had ever exercised two writers at once, which is why the lost update
 * survived so long.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityStore } from '../src/catalog/store.js';
import { referenceCapability } from './fixtures/reference-capability.js';
import type { ReplayResult } from '../src/types/result.js';

const succeeded = (): ReplayResult =>
  ({
    status: 'success',
    meta: {
      runId: 'replay-test',
      capabilityId: 'ref_member_savings_balance',
      capabilityVersion: 1,
      tenantId: 'northstar',
      mode: 'replay',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 10,
      stepsAttempted: 1,
      evidenceDir: '',
      llmCalls: 0,
    },
    outputs: {},
  }) as unknown as ReplayResult;

describe('recordRun under concurrency', () => {
  let dir: string;
  let store: CapabilityStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'handspan-store-'));
    store = new CapabilityStore(dir);
    const cap = referenceCapability('http://localhost:4300');
    cap.governance.stability.runs = 0;
    cap.governance.stability.successes = 0;
    store.save(cap);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('counts every concurrent run exactly once', async () => {
    // Each caller loads its own copy first — which is what the API and the CLI
    // both do, and what made the increments collide. Before the lock, twenty
    // of these recorded somewhere around two.
    const callers = Array.from({ length: 20 }, () => store.load('ref_member_savings_balance'));
    await Promise.all(callers.map((cap) => store.recordRun(cap, succeeded())));

    const after = store.load('ref_member_savings_balance');
    expect(after.governance.stability.runs).toBe(20);
    expect(after.governance.stability.successes).toBe(20);
  });

  it('leaves the caller looking at what was actually persisted', async () => {
    // A stale in-memory score is how a wrong number reaches a report: the
    // caller prints the count it thinks it wrote, not the one on disk.
    const a = store.load('ref_member_savings_balance');
    const b = store.load('ref_member_savings_balance');
    await store.recordRun(a, succeeded());
    await store.recordRun(b, succeeded());

    expect(b.governance.stability.runs).toBe(2);
    expect(b.provenance.contentHash).toBe(
      store.load('ref_member_savings_balance').provenance.contentHash,
    );
  });

  it('leaves no lock file behind', async () => {
    const cap = store.load('ref_member_savings_balance');
    await store.recordRun(cap, succeeded());
    expect(readdirSync(dir).filter((f) => f.endsWith('.lock'))).toEqual([]);
  });

  it('still refuses to count a run that never reached the surface', async () => {
    const cap = store.load('ref_member_savings_balance');
    const rejected = {
      status: 'failure',
      failure: { kind: 'invalid_input', message: 'missing memberId' },
      meta: { llmCalls: 0 },
    } as unknown as ReplayResult;

    expect(await store.recordRun(cap, rejected)).toBe(false);
    expect(store.load('ref_member_savings_balance').governance.stability.runs).toBe(0);
  });
});
