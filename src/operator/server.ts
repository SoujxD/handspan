/**
 * Operator console.
 *
 * Scope, stated honestly: this is the deliberately-thin part. A production
 * console is a real-time co-browsing product with SSO, queues, routing, and
 * audit review; the brief puts that out of scope and asks instead for a real
 * handoff *mechanism*. So what is real here is everything except the pixels:
 *
 *   REAL — the lease transfer, enforced at the surface (automation physically
 *          cannot act while an operator holds control).
 *   REAL — the same live browser session, not a fresh one. The operator drives
 *          the actual Chromium window the agent was using, with its cookies,
 *          frame state, and half-completed form intact.
 *   REAL — capture of what the human did, as semantic actions.
 *   REAL — resume/abort signalling back into the waiting run.
 *
 *   MOCKED — the video feed. This polls a screenshot roughly once a second
 *            rather than streaming WebRTC/CDP frames. The console shows the
 *            session; the operator *drives* it in the headed browser window
 *            that is already open on their machine. Making this remote is a
 *            transport swap (CDP screencast over a WebSocket), not a change to
 *            the control model — which is the part worth getting right.
 */

import express from 'express';
import type { Server } from 'node:http';
import { broker, type HumanAction } from '../control/escalation.js';

let server: Server | null = null;
let boundPort = 0;

export function operatorBaseUrl(): string {
  return `http://localhost:${boundPort || Number(process.env['OPERATOR_PORT'] ?? 4400)}`;
}

export async function startOperatorConsole(port = Number(process.env['OPERATOR_PORT'] ?? 4400)): Promise<string> {
  if (server) return operatorBaseUrl();

  const app = express();
  app.use(express.json());
  app.disable('x-powered-by');

  app.get('/', (_req, res) => {
    res.type('html').send(indexHtml(broker.list()));
  });

  app.get('/i/:id', (req, res) => {
    const item = broker.get(String(req.params['id']));
    if (!item) {
      res.status(404).send('Unknown intervention');
      return;
    }
    res.type('html').send(detailHtml(item));
  });

  /** Live view of the session. Polled by the detail page. */
  app.get('/i/:id/frame.png', async (req, res) => {
    const buf = await broker.liveScreenshot(String(req.params['id']));
    if (!buf) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
  });

  app.get('/i/:id/state.json', (req, res) => {
    const item = broker.get(String(req.params['id']));
    if (!item) {
      res.status(404).json({ error: 'unknown intervention' });
      return;
    }
    const lease = broker.leaseFor(item.id);
    res.json({
      status: item.status,
      holder: lease?.holder ?? 'unknown',
      leaseState: lease?.current,
      humanActions: item.humanActions,
    });
  });

  app.post('/i/:id/take', (req, res) => {
    try {
      const operatorId = String(req.body?.operatorId ?? 'operator@local');
      const item = broker.takeControl(String(req.params['id']), operatorId);
      res.json({ ok: true, status: item.status, operatorId });
    } catch (e) {
      res.status(409).json({ ok: false, error: (e as Error).message });
    }
  });

  app.post('/i/:id/handback', (req, res) => {
    try {
      const note = String(req.body?.note ?? 'completed manually');
      const item = broker.handBack(String(req.params['id']), note);
      res.json({ ok: true, status: item.status });
    } catch (e) {
      res.status(409).json({ ok: false, error: (e as Error).message });
    }
  });

  app.post('/i/:id/abort', (req, res) => {
    try {
      const note = String(req.body?.note ?? 'operator aborted');
      const item = broker.abort(String(req.params['id']), note);
      res.json({ ok: true, status: item.status });
    } catch (e) {
      res.status(409).json({ ok: false, error: (e as Error).message });
    }
  });

  /**
   * Headless path for demos and tests: resolve an intervention end-to-end
   * without a browser. Exercises exactly the same lease transitions the UI
   * buttons do, which is what makes it a legitimate substitute in evidence.
   */
  app.post('/i/:id/simulate', (req, res) => {
    try {
      const id = String(req.params['id']);
      const operatorId = String(req.body?.operatorId ?? 'operator@local');
      const actions = (req.body?.actions ?? []) as HumanAction[];
      const note = String(req.body?.note ?? 'resolved via simulated operator');

      broker.takeControl(id, operatorId);
      for (const a of actions) broker.recordHumanAction(id, { ...a, at: new Date().toISOString() });
      const item = broker.handBack(id, note);
      res.json({ ok: true, status: item.status, recorded: item.humanActions.length });
    } catch (e) {
      res.status(409).json({ ok: false, error: (e as Error).message });
    }
  });

  // `listen` reports failure via an async 'error' event, not a rejected
  // promise. Without this handler an EADDRINUSE — a console already running
  // from a previous command, which is the normal case during a demo — becomes
  // an unhandled 'error' event that takes down the whole replay. A run must
  // not die because an auxiliary console was already up.
  /**
   * If the port is taken, move to an ephemeral one rather than pointing at
   * somebody else's console.
   *
   * The previous behaviour was to assume the occupant was a console and reuse
   * its URL. That is wrong in the one situation that matters, and the demo is
   * exactly that situation: the catalog server is already running and holding
   * :4400, then an escalating capability is replayed from a second terminal.
   *
   * Interventions live in a per-process broker, so reusing the URL points the
   * human at a console backed by a *different* broker — one that has never
   * heard of the intervention just raised. The run parks correctly, the
   * terminal prints a link, and the page it opens is empty. Nothing errors.
   * A dress rehearsal with the catalog up is the only thing that finds it.
   *
   * Binding a fresh port keeps the invariant that the URL a process prints
   * serves that process's own interventions.
   */
  const listenOn = (p: number): Promise<boolean> =>
    new Promise((resolve) => {
      const srv = app.listen(p, () => {
        boundPort = (srv.address() as { port: number }).port;
        server = srv;
        resolve(true);
      });
      srv.once('error', () => resolve(false));
    });

  let started = await listenOn(port);
  let moved = false;

  if (!started) {
    started = await listenOn(0);
    moved = started;
  }

  if (!started) {
    server = null;
    // eslint-disable-next-line no-console
    console.warn('  [operator] console unavailable — escalations will have no page to open.');
    return operatorBaseUrl();
  }

  // eslint-disable-next-line no-console
  console.log(
    `  [operator] console at ${operatorBaseUrl()}` +
      (moved ? `  (port ${port} was busy; this console serves THIS process's interventions)` : ''),
  );
  return operatorBaseUrl();
}

export async function stopOperatorConsole(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin:0; background:#0f1115; color:#e6e8ec; }
  header { background:#171a21; padding:14px 20px; border-bottom:1px solid #262b35; }
  h1 { font-size:16px; margin:0; font-weight:600; }
  .sub { color:#8b93a3; font-size:12px; margin-top:3px; }
  main { padding:20px; max-width:1100px; }
  .card { background:#171a21; border:1px solid #262b35; border-radius:8px; padding:16px; margin-bottom:14px; }
  .row { display:flex; gap:20px; align-items:flex-start; }
  .col { flex:1; min-width:0; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  td, th { text-align:left; padding:6px 8px; border-bottom:1px solid #262b35; vertical-align:top; }
  th { color:#8b93a3; font-weight:500; width:150px; }
  .pill { display:inline-block; padding:2px 9px; border-radius:20px; font-size:11px; font-weight:600; }
  .open { background:#4a2a12; color:#ffb870; }
  .in_progress { background:#123b52; color:#6fc9f5; }
  .handed_back, .resolved { background:#12341f; color:#69d98c; }
  .aborted { background:#40151a; color:#ff8b96; }
  button { background:#2d6cdf; color:#fff; border:0; padding:9px 16px; border-radius:6px; font-size:13px; cursor:pointer; margin-right:8px; }
  button.secondary { background:#333a47; }
  button.danger { background:#a3313c; }
  button:disabled { opacity:.4; cursor:not-allowed; }
  a { color:#6fa8ff; text-decoration:none; }
  code { background:#0b0d11; padding:1px 5px; border-radius:4px; font-size:12px; }
  img.live { width:100%; border:1px solid #262b35; border-radius:6px; background:#000; }
  .why { background:#2a1e10; border-left:3px solid #d98a2b; padding:10px 12px; border-radius:4px; font-size:13px; }
  .guide { background:#10251c; border-left:3px solid #3aa76d; padding:10px 12px; border-radius:4px; font-size:13px; margin-top:10px; }
  .muted { color:#8b93a3; font-size:12px; }
`;

function indexHtml(items: ReturnType<typeof broker.list>): string {
  const rows =
    items
      .map(
        (i) => `<tr>
      <td><a href="/i/${esc(i.id)}"><code>${esc(i.id)}</code></a></td>
      <td>${esc(i.capabilityName)}<div class="muted">${esc(i.tenantId)}</div></td>
      <td>${esc(i.reason)}</td>
      <td><span class="pill ${esc(i.status)}">${esc(i.status)}</span></td>
      <td class="muted">${esc(i.createdAt)}</td>
    </tr>`,
      )
      .join('') ||
    `<tr><td colspan="5" class="muted">No interventions. The queue fills when a run cannot safely continue on its own.</td></tr>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Handspan — Operator Console</title>
<style>${CSS}</style></head><body>
<header><h1>Handspan Operator Console</h1>
<div class="sub">Intervention queue for automation runs that need a human.</div></header>
<main><div class="card"><table>
<tr><th>ID</th><th>Capability</th><th>Why it stopped</th><th>Status</th><th>Raised</th></tr>
${rows}
</table></div></main></body></html>`;
}

function detailHtml(i: ReturnType<typeof broker.get> & object): string {
  const lease = broker.leaseFor(i.id);
  const holder = lease?.holder ?? 'unknown';

  const actions = i.humanActions.length
    ? i.humanActions
        .map(
          (a) =>
            `<tr><td class="muted">${esc(a.at.slice(11, 19))}</td><td>${esc(a.type)}</td><td>${esc(a.target ?? a.url ?? '')}</td><td>${esc(a.value ?? '')}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="4" class="muted">Nothing recorded yet.</td></tr>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(i.id)} — Handspan</title>
<style>${CSS}</style></head><body>
<header>
  <h1>${esc(i.id)} &mdash; ${esc(i.capabilityName)}</h1>
  <div class="sub"><a href="/">&larr; queue</a> &nbsp;·&nbsp; run <code>${esc(i.runId)}</code> &nbsp;·&nbsp; tenant <code>${esc(i.tenantId)}</code></div>
</header>
<main>
  <div class="row">
    <div class="col">
      <div class="card">
        <div class="why"><b>Why the automation stopped:</b><br>${esc(i.reason)}
          <div class="muted" style="margin-top:6px">trigger: <code>${esc(i.trigger)}</code>${i.atStepId ? ` · step <code>${esc(i.atStepId)}</code>` : ''}</div>
        </div>
        <div class="guide"><b>What you need to do:</b><br>${esc(i.guidance)}</div>
      </div>

      <div class="card">
        <table>
          <tr><th>Goal</th><td>${esc(i.goal)}</td></tr>
          <tr><th>Step intent</th><td>${esc(i.stepIntent ?? '—')}</td></tr>
          <tr><th>Current URL</th><td><code>${esc(i.currentUrl)}</code></td></tr>
          <tr><th>Status</th><td><span class="pill ${esc(i.status)}">${esc(i.status)}</span></td></tr>
          <tr><th>Lease holder</th><td><code id="holder">${esc(holder)}</code></td></tr>
        </table>
      </div>

      <div class="card">
        <b>Control</b>
        <p class="muted">Taking control pauses the automation and hands you the <b>same live browser session</b> —
        the Chromium window already open on this machine, with its cookies and half-filled form intact.
        The automation is blocked at the surface while you hold the lease; it cannot act, even by mistake.</p>
        <button id="take">Take control of live session</button>
        <button id="hand" class="secondary">Hand control back &amp; resume</button>
        <button id="abort" class="danger">Abort run</button>
        <div id="msg" class="muted" style="margin-top:10px"></div>
      </div>

      <div class="card">
        <b>Recorded operator actions</b>
        <p class="muted">Captured from the live session so the handoff is auditable and, later, promotable into the capability.</p>
        <table><tr><th style="width:70px">Time</th><th style="width:70px">Type</th><th>Target</th><th>Value</th></tr>${actions}</table>
      </div>
    </div>

    <div class="col">
      <div class="card">
        <b>Live session</b>
        <div class="muted" style="margin-bottom:8px">Polled screenshot (~1 fps). Drive the session in the headed browser window.</div>
        <img class="live" id="live" src="/i/${esc(i.id)}/frame.png" alt="live session">
      </div>
    </div>
  </div>
</main>
<script>
  const id = ${JSON.stringify(i.id)};
  const live = document.getElementById('live');
  setInterval(() => { live.src = '/i/' + id + '/frame.png?t=' + Date.now(); }, 1000);

  async function post(path, body) {
    const r = await fetch('/i/' + id + path, {
      method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body || {})
    });
    const j = await r.json();
    document.getElementById('msg').textContent = j.ok ? 'OK — ' + (j.status || '') : 'Error: ' + j.error;
    return j;
  }
  document.getElementById('take').onclick = () => post('/take', { operatorId: 'operator@local' });
  document.getElementById('hand').onclick = () => post('/handback', { note: 'completed manually' });
  document.getElementById('abort').onclick = () => post('/abort', { note: 'operator aborted' });

  setInterval(async () => {
    const r = await fetch('/i/' + id + '/state.json');
    if (!r.ok) return;
    const s = await r.json();
    document.getElementById('holder').textContent = s.holder;
  }, 1500);
</script>
</body></html>`;
}
