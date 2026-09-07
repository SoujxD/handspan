/**
 * The operator console builds its page as a template literal, so the whole
 * page — including its inline script — is a string the TypeScript compiler
 * never looks inside.
 *
 * That has bitten this project once already, in the dashboard: a bad escape
 * left a string unterminated, the browser abandoned the script, and every
 * control on the page went dead while the server still answered 200. The
 * console is more dangerous, because it is the page a supervisor opens in the
 * middle of a parked run — if its buttons stop working, a run that stopped
 * safely cannot be handed back.
 *
 * A template literal has its own trap on top of that: a backtick anywhere in
 * the page source, even inside a comment, ends the literal early. That is a
 * compile error rather than a silent one, but this parses the page a browser
 * would actually receive, which is the thing that matters.
 */

import { describe, expect, it, afterAll } from 'vitest';
import { Script } from 'node:vm';
import { broker } from '../src/control/escalation.js';
import { SessionLease } from '../src/control/lease.js';
import { startOperatorConsole, stopOperatorConsole } from '../src/operator/server.js';

const lease = new SessionLease('test-run');

const intervention = broker.create(
  {
    runId: 'test-run',
    capabilityId: 'test_capability',
    capabilityName: 'Test capability',
    tenantId: 'meridian-demo',
    goal: 'exercise the console page',
    trigger: 'declared_outcome',
    reason: 'a reason the operator should see',
    guidance: 'what the operator should do',
    atStepId: 's01',
    stepIntent: 'a step',
    currentUrl: 'https://example.test/screen',
  },
  lease,
  async () => Buffer.alloc(0),
);

// Bind an ephemeral port so this never fights a console the developer is running.
const base = await startOperatorConsole(0);

afterAll(async () => {
  await stopOperatorConsole();
});

describe('operator console page', () => {
  it('serves the intervention page', async () => {
    const res = await fetch(`${base}/i/${intervention.id}`);
    expect(res.status).toBe(200);
  });

  it('the inline script parses as JavaScript', async () => {
    const html = await fetch(`${base}/i/${intervention.id}`).then((r) => r.text());
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
    expect(scripts.length).toBeGreaterThan(0);
    scripts.forEach((source, i) => {
      expect(() => new Script(source, { filename: `console#script${i}` })).not.toThrow();
    });
  });

  it('carries the controls a stuck run depends on', async () => {
    const html = await fetch(`${base}/i/${intervention.id}`).then((r) => r.text());
    for (const id of ['take', 'hand', 'abort', 'live', 'holder']) {
      expect(html).toContain(`id="${id}"`);
    }
    // The reason and guidance are the whole point of routing an intervention.
    expect(html).toContain('a reason the operator should see');
    expect(html).toContain('what the operator should do');
  });
});
