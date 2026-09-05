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
import {
  PATHS,
  PROJECT_ROOT,
  buildRedactor,
  boundInputNames,
  fillSecretsFromEnvironment,
  loadPolicy,
  newRunId,
  observationRedactionHook,
  runtimeConfig,
} from '../config.js';
import { listRuns, readRun } from './runs.js';
import { chat, describeResult, type ChatTurn } from './chat.js';
import { computeAdaptation } from './adaptation.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvidenceRecorder } from '../evidence/recorder.js';
import { SessionLease } from '../control/lease.js';
import { PlaywrightSurface } from '../surface/web/playwright-surface.js';
import { replay } from '../replay/engine.js';
import { detemplatize } from '../agent/compiler.js';
import { exitCodeFor, type ReplayResult } from '../types/result.js';
import { startOperatorConsole, operatorBaseUrl } from '../operator/server.js';

/** The vendor build and institution this catalog fronts. */
const PRODUCT = 'cornerstone-meridian-core';
const DEFAULT_TENANT = 'meridian-demo';

export async function startCatalog(port = runtimeConfig().catalogPort): Promise<Server> {
  const store = new CapabilityStore(PATHS.artifacts);
  const app = express();
  app.use(express.json());
  app.disable('x-powered-by');

  /**
   * The catalog an agent discovers, scoped to the product this catalog fronts.
   *
   * It used to return everything on disk, which mixed MERIDIAN CORE's
   * capabilities with the take-home fixture's — two different applications that
   * happen to share a repo. An agent reading the list could pick a tool whose
   * tenant this deployment has never heard of and get an error it could not
   * have predicted from the catalog it was given. The chatbot already filtered
   * by product; the endpoint underneath it did not, so the two disagreed about
   * what existed.
   *
   * `?product=all` returns everything, which is what the take-home's own demo
   * path needs, and `?product=<id>` selects another. Invoking by id is
   * deliberately NOT filtered: the listing decides what an agent should
   * discover, not what the operator of this process is allowed to run.
   */
  app.get('/capabilities', (req, res) => {
    const want = String(req.query['product'] ?? PRODUCT);
    const all = store.listLatest();
    const caps = want === 'all' ? all : all.filter((c) => c.surface.product === want);
    res.json({
      product: want,
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

  /**
   * One invocation path, used by the HTTP route and by the chatbot alike.
   *
   * Extracted so there is exactly one place where a capability meets the
   * replay engine. The brief's warning is that the wrapper becomes a way
   * around the guardrails; the structural answer is that there is no second
   * path to be lax about.
   */
  async function invokeCapability(
    id: string,
    body: Record<string, unknown>,
  ): Promise<{ result: ReplayResult; runId: string; rejectedSecrets: string[] }> {
    const cap = store.load(id);
    const tenantId = String(body['tenantId'] ?? cap.surface.recordedOnTenant);
    const tenant = cap.tenants.find((t) => t.tenantId === tenantId);
    if (!tenant) throw new Error(`Unknown tenant "${tenantId}" for capability "${id}".`);

    /**
     * Secrets are read from this process's environment, never from the request.
     *
     * A caller — and the chatbot in particular — has no business holding an
     * operator credential, and anything in a request body ends up in an access
     * log and, through the bot, in a model transcript. The CLI already worked
     * this way; the HTTP surface did not, which made the wrapper quietly a way
     * around a guarantee the core enforces.
     */
    const bound = new Set(boundInputNames());
    const serverSupplied = (name: string, sensitivity: string): boolean =>
      sensitivity === 'secret' || bound.has(name);

    const supplied: Record<string, string> = {};
    for (const p of cap.inputs) {
      if (serverSupplied(p.name, p.sensitivity)) continue;
      const v = body[p.name];
      if (v !== undefined) supplied[p.name] = String(v);
    }
    const rejectedSecrets = cap.inputs
      .filter((p) => serverSupplied(p.name, p.sensitivity) && body[p.name] !== undefined)
      .map((p) => p.name);
    const inputs = fillSecretsFromEnvironment(cap, supplied);

    const policy = loadPolicy();
    const redactor = buildRedactor(policy);
    const runId = newRunId('replay');
    const evidence = new EvidenceRecorder(runId, PATHS.evidence, redactor, false);
    const lease = new SessionLease(runId);

    await startOperatorConsole().catch(() => undefined);

    let surface: PlaywrightSurface | undefined;
    let result: ReplayResult;
    try {
      surface = await PlaywrightSurface.launch({
        lease,
        headless: runtimeConfig().headless,
        defaultTimeoutMs: policy.limits.defaultActionTimeoutMs,
        onObserve: observationRedactionHook(policy, redactor),
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

      await store.recordRun(cap, result);
      evidence.saveJson('result', result);
    } finally {
      // Escalated runs keep the session alive for the operator; everything
      // else releases the browser.
      if (surface && result! && result!.status !== 'escalated') await surface.close();
      else if (surface && !result!) await surface.close();
    }

    return { result, runId, rejectedSecrets };
  }

  app.post('/capabilities/:id/invoke', async (req, res) => {
    const id = String(req.params['id']);
    try {
      const { result, runId, rejectedSecrets } = await invokeCapability(
        id,
        (req.body ?? {}) as Record<string, unknown>,
      );
      // Lets a dashboard or a caller follow this run in the evidence trail.
      res.setHeader('x-handspan-run-id', runId);
      if (rejectedSecrets.length) {
        // Told, not silently dropped: a caller that sent a credential should
        // learn that this surface refuses to accept one.
        res.setHeader('x-handspan-ignored-secret-inputs', rejectedSecrets.join(','));
      }
      res.status(httpStatusFor(result)).json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * Read-only surfaces the dashboard and chatbot need.
   *
   * There is no SSE stream. Deliberately: a poll every couple of seconds shows
   * a run advancing just as well for a demo, needs no reconnection handling,
   * and cannot leave a socket open against a browser that navigated away. The
   * brief asks for both surfaces to be intentionally simple, and a stream
   * would be the more impressive-looking of two things that do the same job.
   */
  app.get('/runs', (req, res) => {
    const limit = Math.min(500, Number(req.query['limit'] ?? 100) || 100);
    const kind = req.query['kind'] as string | undefined;
    let runs = listRuns(PATHS.evidence, limit);
    if (kind) runs = runs.filter((r) => r.kind === kind);
    res.json({ count: runs.length, runs });
  });

  app.get('/runs/:id', (req, res) => {
    const run = readRun(PATHS.evidence, String(req.params['id']));
    if (!run) {
      res.status(404).json({ error: `No run "${String(req.params['id'])}".` });
      return;
    }
    res.json(run);
  });

  /**
   * One evidence file from one run.
   *
   * The run detail listed the files a run produced and their sizes, which tells
   * a reviewer that a screenshot exists without letting them look at it. The
   * brief asks for the evidence to be *visible* — steps, screenshots, DOM
   * snapshots, timings, logs — because that is how someone debugs a run they
   * did not watch happen.
   *
   * Serving these is safe by construction rather than by intention: screenshots
   * are masked in the browser before the pixels are ever captured, and every
   * JSON or log file went through the redactor on its way to disk. There is no
   * unredacted copy on disk to leak.
   *
   * Both path segments are validated. `readRun` already refuses a run id that
   * is not exactly a run id; the filename is checked here against the run's own
   * directory listing rather than by pattern, so what is served is necessarily
   * a file that run produced, and `..` has nothing to traverse to.
   */
  app.get('/runs/:id/evidence/:file', (req, res) => {
    const runId = String(req.params['id']);
    const run = readRun(PATHS.evidence, runId);
    if (!run) {
      res.status(404).json({ error: `No run "${runId}".` });
      return;
    }
    const name = String(req.params['file']);
    if (!run.evidence.some((f) => f.name === name)) {
      res.status(404).json({ error: `Run "${runId}" produced no file "${name}".` });
      return;
    }

    const types: Record<string, string> = {
      '.png': 'image/png',
      '.json': 'application/json',
      '.jsonl': 'application/x-ndjson',
      '.txt': 'text/plain; charset=utf-8',
      '.html': 'text/plain; charset=utf-8',
    };
    const ext = name.slice(name.lastIndexOf('.'));
    // A DOM snapshot is served as text, never as html: it is evidence to read,
    // not a document to execute in the dashboard's origin.
    res.type(types[ext] ?? 'application/octet-stream');
    res.setHeader('content-security-policy', "default-src 'none'; sandbox");
    res.send(readFileSync(join(PATHS.evidence, runId, name)));
  });

  app.get('/adaptation', (_req, res) => {
    res.json(
      computeAdaptation({
        projectRoot: PROJECT_ROOT,
        evidenceDir: PATHS.evidence,
        artifactsDir: PATHS.artifacts,
        product: 'cornerstone-meridian-core',
        tenantId: 'meridian-demo',
      }),
    );
  });

  /** The dashboard. One file, no build step, no framework. */
  app.get('/', (_req, res) => {
    res.type('html').send(readFileSync(join(PROJECT_ROOT, 'src', 'catalog', 'dashboard.html'), 'utf8'));
  });

  /**
   * The chatbot turn.
   *
   * It goes through the same `POST /capabilities/:id/invoke` path as any other
   * caller — same policy gate, same confirmation rule, same evidence. The bot
   * is a driver over the API, not a second way in, which is the thing the
   * brief warns about: don't let the wrapper become a way around the guardrails.
   */
  app.post('/chat', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    try {
      // Second turn: the HUMAN authorised a commit. The token is minted here,
      // in code, from their action - never by the model, which by this point
      // has already had its say and is not consulted again.
      if (body['confirmed'] === true && typeof body['capabilityId'] === 'string') {
        const capabilityId = body['capabilityId'];
        const cap = store.load(capabilityId);
        const args = (body['args'] ?? {}) as Record<string, unknown>;
        const invocation = await invokeCapability(capabilityId, {
          ...args,
          tenantId: body['tenantId'] ?? cap.surface.recordedOnTenant,
          confirm: capabilityId,
        });
        res.json({
          type: 'result',
          capabilityId,
          runId: invocation.runId,
          httpStatus: httpStatusFor(invocation.result),
          text: describeResult(invocation.result, cap.name),
          result: invocation.result,
        });
        return;
      }

      const reply = await chat({
        store,
        product: PRODUCT,
        defaultTenantId: DEFAULT_TENANT,
        history: Array.isArray(body['history']) ? (body['history'] as ChatTurn[]) : [],
        message: String(body['message'] ?? ''),
      });

      if (reply.type !== 'invoked') {
        res.json(reply);
        return;
      }

      const cap = store.load(reply.capabilityId);
      const invocation = await invokeCapability(reply.capabilityId, {
        ...reply.args,
        tenantId: DEFAULT_TENANT,
      });
      res.json({
        type: 'result',
        capabilityId: reply.capabilityId,
        runId: invocation.runId,
        httpStatus: httpStatusFor(invocation.result),
        text: describeResult(invocation.result, cap.name),
        result: invocation.result,
        modelCalls: reply.modelCalls,
      });
    } catch (e) {
      res.status(500).json({ type: 'error', error: (e as Error).message });
    }
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`[catalog] agent-facing capability API on http://localhost:${port}`);
      // eslint-disable-next-line no-console
      console.log(`[catalog]   GET  /capabilities`);
      // eslint-disable-next-line no-console
      console.log(`[catalog]   POST /capabilities/:id/invoke`);
      resolve(server);
    });

    /**
     * Say what is wrong, rather than throwing a listen stack trace.
     *
     * Unlike the operator console, this deliberately does NOT move to another
     * port. The console's URL is printed for a human to click, so any port will
     * do; this one is an address a caller has configured, and quietly serving
     * it from somewhere else would mean the dashboard and the chatbot talk to
     * a catalog nobody knows about.
     *
     * It matters because the stale process keeps answering. A second catalog
     * started after a code change died on this error, the old one carried on
     * serving 4500, and the request came back looking like the change had not
     * worked.
     */
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${port} is already in use, so the catalog did not start — ` +
              `and whatever is already on ${port} will keep answering.
` +
              `  Stop it first, or run with CATALOG_PORT=<other port>.`,
          ),
        );
        return;
      }
      reject(e);
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
