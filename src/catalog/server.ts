/**
 * Capability catalog API — the agent-facing invocation surface.
 *
 * Two endpoints do the whole job, which is the point: because the artifact
 * already carries a typed contract, exposing it to an agent needs almost no
 * new code.
 *
 *   GET  /capabilities        discovery — a list of function-calling tool
 *                             definitions an agent can drop straight into its
 *                             `tools` array.
 *   POST /capabilities/:id    invocation — typed args in, the same
 *                             `ReplayResult` union out.
 *
 * The HTTP status mapping is where the result contract earns its keep:
 *
 *   200 success            the flow completed, outputs attached
 *   200 business outcome   a valid answer that happens not to be the happy path
 *   202 escalated          parked on a human, not lost
 *   4xx/5xx failure        an actual failure, split by whose fault it is
 *
 * A business outcome returning 200 is deliberate. "No such member" is an
 * answer; a caller with retry-on-non-2xx must not retry it forever, and a
 * dashboard must not count it as an error.
 */

import express from 'express';
import type { Server } from 'node:http';
import { CapabilityStore, toToolDefinition } from './store.js';
import { PATHS, buildRedactor, loadPolicy, newRunId, runtimeConfig } from '../config.js';
import { EvidenceRecorder } from '../evidence/recorder.js';
import { SessionLease } from '../control/lease.js';
import { PlaywrightSurface } from '../surface/web/playwright-surface.js';
import { replay } from '../replay/engine.js';
import { detemplatize } from '../agent/compiler.js';
import { exitCodeFor, type ReplayResult } from '../types/result.js';
import { startOperatorConsole, operatorBaseUrl } from '../operator/server.js';

export async function startCatalog(port = runtimeConfig().catalogPort): Promise<Server> {
  const store = new CapabilityStore(PATHS.artifacts);
  const app = express();
  app.use(express.json());
  app.disable('x-powered-by');

  app.get('/capabilities', (_req, res) => {
    const caps = store.listLatest();
    res.json({
      count: caps.length,
      tools: caps.map(toToolDefinition),
    });
  });

  app.get('/capabilities/:id', (req, res) => {
    try {
      const cap = store.load(String(req.params['id']));
      res.json({ tool: toToolDefinition(cap), artifact: cap });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  app.post('/capabilities/:id/invoke', async (req, res) => {
    const id = String(req.params['id']);
    const body = (req.body ?? {}) as Record<string, unknown>;

    let result: ReplayResult;
    let surface: PlaywrightSurface | undefined;

    try {
      const cap = store.load(id);
      const tenantId = String(body['tenantId'] ?? cap.surface.recordedOnTenant);
      const tenant = cap.tenants.find((t) => t.tenantId === tenantId);
      if (!tenant) {
        res.status(400).json({ error: `Unknown tenant "${tenantId}" for capability "${id}".` });
        return;
      }

      const inputs: Record<string, string> = {};
      for (const p of cap.inputs) {
        const v = body[p.name];
        if (v !== undefined) inputs[p.name] = String(v);
      }

      const policy = loadPolicy();
      const redactor = buildRedactor(policy);
      const runId = newRunId('replay');
      const evidence = new EvidenceRecorder(runId, PATHS.evidence, redactor, false);
      const lease = new SessionLease(runId);

      await startOperatorConsole().catch(() => undefined);

      surface = await PlaywrightSurface.launch({
        lease,
        headless: runtimeConfig().headless,
        defaultTimeoutMs: policy.limits.defaultActionTimeoutMs,
      });

      await surface.act({ kind: 'navigate', url: detemplatize(cap.surface.entryUrl, tenant.baseUrl) });

      result = await replay({
        capability: cap,
        tenantId,
        inputs,
        surface,
        policy,
        redactor,
        evidence,
        lease,
        runId,
        // An HTTP invocation is by definition unattended: nobody is watching.
        mode: 'unattended',
        confirmationToken: typeof body['confirm'] === 'string' ? body['confirm'] : undefined,
        operatorBaseUrl: operatorBaseUrl(),
      });

      store.recordRun(cap, result.status === 'success' || result.status === 'outcome');
      evidence.saveJson('result', result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
      await surface?.close();
      return;
    } finally {
      // Escalated runs keep the session alive for the operator; everything
      // else releases the browser.
      if (surface && result! && result!.status !== 'escalated') await surface.close();
    }

    res.status(httpStatusFor(result!)).json(result!);
  });

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`[catalog] agent-facing capability API on http://localhost:${port}`);
      // eslint-disable-next-line no-console
      console.log(`[catalog]   GET  /capabilities`);
      // eslint-disable-next-line no-console
      console.log(`[catalog]   POST /capabilities/:id/invoke`);
      resolve(server);
    });
  });
}

function httpStatusFor(r: ReplayResult): number {
  if (r.status === 'success' || r.status === 'outcome') return 200;
  if (r.status === 'escalated') return 202;

  switch (r.failure.kind) {
    case 'invalid_input':
    case 'artifact_invalid':
      return 400;
    case 'policy_denied':
      return 403;
    case 'timeout':
      return 504;
    case 'surface_error':
      return 502;
    default:
      // Everything else is our fault, not the caller's.
      return 500;
  }
}

export { exitCodeFor };
