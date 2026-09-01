/**
 * "Meridian Core" — a mock legacy core-banking servicing console.
 *
 * Two tenants run the same vendor product with different skins, labels, and
 * element ids. A control endpoint injects the runtime conditions that make
 * replay hard in production: validation errors, unexpected interstitials,
 * session expiry, slow loads, and outright 500s.
 *
 *   npm run target      # http://localhost:4300
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import {
  MEMBERS,
  findMember,
  tenantOf,
  runtimeState,
  FAULT_MODES,
  UPGRADE_VARIANTS,
  type UpgradeLevel,
  type FaultMode,
  type TenantConfig,
} from './data.js';
import * as V from './views.js';

const PORT = Number(process.env['TARGET_APP_PORT'] ?? 4300);
const app = express();

app.use(express.urlencoded({ extended: false }));
app.disable('x-powered-by');

// ---------------------------------------------------------------------------
// Fault injection control plane.
//
// Deliberately a *separate* surface from the app itself. The replay engine
// never touches it — the harness does, before a run. That keeps the artifact
// honest: it has no idea a fault was injected, exactly as in production.
// ---------------------------------------------------------------------------

app.get('/__control/fault', (_req, res) => {
  res.json({ fault: runtimeState.fault, available: FAULT_MODES });
});

app.post('/__control/fault', (req, res) => {
  const mode = String(req.query['mode'] ?? req.body?.mode ?? 'none') as FaultMode;
  if (!FAULT_MODES.includes(mode)) {
    res.status(400).json({ error: `unknown fault mode: ${mode}`, available: FAULT_MODES });
    return;
  }
  runtimeState.fault = mode;
  // eslint-disable-next-line no-console
  console.log(`[target-app] fault mode -> ${mode}`);
  res.json({ fault: runtimeState.fault });
});

/**
 * Ship the vendor upgrade.
 *
 * Separate from the fault endpoint on purpose: a fault is something going
 * wrong, and this is the institution's software working exactly as intended
 * while every capability recorded against 8.4 quietly stops matching. They are
 * different operational events and they deserve different switches.
 */
app.post('/__control/upgrade', (req, res) => {
  const level = String(req.query['level'] ?? req.body?.level ?? 'minor') as UpgradeLevel;
  if (!['none', 'minor', 'major'].includes(level)) {
    res.status(400).json({ error: `unknown upgrade level: ${level}`, available: ['none', 'minor', 'major'] });
    return;
  }
  runtimeState.productUpgrade = level;
  const version = level === 'none' ? '8.4/8.6 (base)' : UPGRADE_VARIANTS[level].version;
  // eslint-disable-next-line no-console
  console.log(`[target-app] product version -> ${version}`);
  res.json({ productUpgrade: level, version });
});

app.get('/__control/health', (_req, res) =>
  res.json({ ok: true, fault: runtimeState.fault, productUpgrade: runtimeState.productUpgrade }),
);

// ---------------------------------------------------------------------------
// Tenant resolution
// ---------------------------------------------------------------------------

interface TenantRequest extends Request {
  tenant?: TenantConfig;
}

function withTenant(req: TenantRequest, res: Response, next: NextFunction): void {
  const t = tenantOf(String(req.params['tenant']));
  if (!t) {
    res.status(404).send('Unknown institution');
    return;
  }
  req.tenant = t;
  next();
}

const T = (req: TenantRequest): TenantConfig => req.tenant!;

/** Fake session: a cookie header check. Enough to make login a real step. */
function isSignedIn(req: Request): boolean {
  return String(req.headers.cookie ?? '').includes('mc_session=');
}

/**
 * Guards that fire before content routes. Order matters and mirrors reality:
 * a session check precedes everything, then the server may be sick, then it
 * may be slow, then it may interpose a dialog.
 */
function contentGuards(nextUrl: string) {
  return async (req: TenantRequest, res: Response, next: NextFunction): Promise<void> => {
    const t = T(req);

    if (runtimeState.fault === 'session_timeout') {
      res.status(200).send(V.sessionExpiredPage(t));
      return;
    }
    if (!isSignedIn(req)) {
      res.status(200).send(V.sessionExpiredPage(t));
      return;
    }
    if (runtimeState.fault === 'server_error') {
      res.status(500).send(V.serverErrorPage(t));
      return;
    }
    if (runtimeState.fault === 'slow_load') {
      // Long enough to blow a naive fixed wait, short enough that a
      // correctly-implemented condition wait still succeeds.
      await new Promise((r) => setTimeout(r, 6000));
    }
    if (runtimeState.fault === 'unexpected_dialog' && !('ack' in req.query)) {
      // Carry the interrupted request's own parameters through the advisory,
      // so acknowledging it resumes what the operator was doing rather than
      // restarting it with empty inputs. See the comment in views.ts.
      const carry: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v === 'string') carry[k] = v;
      }
      const path = String(req.originalUrl ?? nextUrl).split('?')[0] ?? nextUrl;
      res.status(200).send(V.unexpectedDialogPage(t, path, carry));
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html><html><body style="font-family:Verdana;font-size:12px;padding:40px">
  <h3>Meridian Core (mock)</h3>
  <p>Two institutions run this same vendor product:</p>
  <ul>
    <li><a href="/t/northstar/login">Northstar Community Credit Union</a> &mdash; base recording tenant</li>
    <li><a href="/t/lakeshore/login">Lakeshore Federal Credit Union</a> &mdash; variant tenant (different labels, ids, and a daily-notice interstitial)</li>
  </ul>
  <p>Fault control: <code>POST /__control/fault?mode=validation</code></p>
  </body></html>`);
});

app.get('/t/:tenant', withTenant, (req: TenantRequest, res) =>
  res.redirect(`/t/${T(req).slug}/login`),
);

app.get('/t/:tenant/login', withTenant, (req: TenantRequest, res) => {
  res.send(V.loginPage(T(req)));
});

app.post('/t/:tenant/login', withTenant, (req: TenantRequest, res) => {
  const t = T(req);
  const p = t.idPrefix;
  const user = String(req.body[`${p}txtUser`] ?? '').trim();
  const pwd = String(req.body[`${p}txtPwd`] ?? '');

  const expectedUser = process.env['DEMO_USERNAME'] ?? 'teller01';
  const expectedPwd = process.env['DEMO_PASSWORD'] ?? 'demo-pass-1234';

  if (user !== expectedUser || pwd !== expectedPwd) {
    res.status(200).send(V.loginPage(t, 'Invalid user ID or password.'));
    return;
  }
  res.setHeader('Set-Cookie', 'mc_session=ok; Path=/; HttpOnly; SameSite=Lax');
  // Lakeshore always shows a daily notice; Northstar goes straight through.
  const landing = t.showDailyNotice ? `/t/${t.slug}/notice` : `/t/${t.slug}/home`;
  res.redirect(`/t/${t.slug}/shell?to=${encodeURIComponent(landing)}`);
});

app.get('/t/:tenant/logout', withTenant, (req: TenantRequest, res) => {
  res.setHeader('Set-Cookie', 'mc_session=; Path=/; Max-Age=0');
  res.redirect(`/t/${T(req).slug}/login`);
});

app.get('/t/:tenant/shell', withTenant, (req: TenantRequest, res) => {
  const t = T(req);
  const to = String(req.query['to'] ?? `/t/${t.slug}/home`);
  res.send(V.shell(t, to));
});

app.get('/t/:tenant/notice', withTenant, (req: TenantRequest, res) => {
  const t = T(req);
  res.send(V.dailyNoticePage(t, `/t/${t.slug}/home`));
});

app.get(
  '/t/:tenant/home',
  withTenant,
  (req: TenantRequest, res, next) => contentGuards(`/t/${T(req).slug}/home`)(req, res, next),
  (req: TenantRequest, res) => res.send(V.homePage(T(req))),
);

app.get(
  '/t/:tenant/member/search',
  withTenant,
  (req: TenantRequest, res, next) =>
    contentGuards(`/t/${T(req).slug}/member/search`)(req, res, next),
  (req: TenantRequest, res) => res.send(V.memberSearchPage(T(req))),
);

app.get(
  '/t/:tenant/member/results',
  withTenant,
  (req: TenantRequest, res, next) =>
    contentGuards(`/t/${T(req).slug}/member/results`)(req, res, next),
  (req: TenantRequest, res) => {
    const t = T(req);
    const q = String(req.query['mbr'] ?? '').trim();
    const last = String(req.query['last'] ?? '').trim();

    if (!q && !last) {
      res.send(V.memberSearchPage(t, `${t.labels.memberId} or Last Name is required.`));
      return;
    }
    const m = q ? findMember(q) : MEMBERS.find((x) => x.lastName.toLowerCase() === last.toLowerCase());
    if (!m) {
      // 200, not 404: "no such member" is an answer, not a failure.
      res.status(200).send(V.notFoundPage(t, q || last));
      return;
    }
    res.redirect(`/t/${t.slug}/member/${m.id}`);
  },
);

app.get(
  '/t/:tenant/member/:id',
  withTenant,
  (req: TenantRequest, res, next) =>
    contentGuards(`/t/${T(req).slug}/member/${req.params['id']}`)(req, res, next),
  (req: TenantRequest, res) => {
    const t = T(req);
    const m = findMember(String(req.params['id']));
    if (!m) {
      res.status(200).send(V.notFoundPage(t, String(req.params['id'])));
      return;
    }
    if (m.status === 'RESTRICTED') {
      res.status(200).send(V.permissionDeniedPage(t, m.id));
      return;
    }
    res.send(V.memberDetailPage(t, m));
  },
);

app.get(
  '/t/:tenant/member/:id/subaccount/new',
  withTenant,
  (req: TenantRequest, res, next) =>
    contentGuards(`/t/${T(req).slug}/member/${req.params['id']}/subaccount/new`)(req, res, next),
  (req: TenantRequest, res) => {
    const t = T(req);
    const m = findMember(String(req.params['id']));
    if (!m) {
      res.status(200).send(V.notFoundPage(t, String(req.params['id'])));
      return;
    }
    res.send(V.subAccountFormPage(t, m, []));
  },
);

app.post(
  '/t/:tenant/member/:id/subaccount/review',
  withTenant,
  (req: TenantRequest, res, next) =>
    contentGuards(`/t/${T(req).slug}/member/${req.params['id']}/subaccount/new`)(req, res, next),
  (req: TenantRequest, res) => {
    const t = T(req);
    const m = findMember(String(req.params['id']));
    if (!m) {
      res.status(200).send(V.notFoundPage(t, String(req.params['id'])));
      return;
    }

    const type = String(req.body['type'] ?? '');
    const nickname = String(req.body['nickname'] ?? '').trim();
    const amount = String(req.body['amount'] ?? '').trim();
    const errors: string[] = [];

    if (runtimeState.fault === 'validation') {
      // Server-side rule that only fires at runtime — the classic case a
      // happy-path recording never sees.
      errors.push('Product code is not available for this member class. Contact Operations.');
    }
    if (!type) errors.push(`${t.labels.accountType} is required.`);
    if (!nickname) errors.push(`${t.labels.nickname} is required.`);
    const amt = Number(amount.replace(/[^0-9.]/g, ''));
    if (!amount) errors.push(`${t.labels.initialDeposit} is required.`);
    else if (Number.isNaN(amt)) errors.push(`${t.labels.initialDeposit} must be a number.`);
    else if (amt < 25) errors.push(`${t.labels.initialDeposit} must be at least 25.00.`);

    if (errors.length) {
      res.status(200).send(V.subAccountFormPage(t, m, errors, { type, nickname, amount }));
      return;
    }
    res.send(V.reviewPage(t, m, { type, nickname, amount: amt.toFixed(2) }));
  },
);

app.post(
  '/t/:tenant/member/:id/subaccount/confirm',
  withTenant,
  (req: TenantRequest, res, next) =>
    contentGuards(`/t/${T(req).slug}/member/${req.params['id']}`)(req, res, next),
  (req: TenantRequest, res) => {
    const t = T(req);
    const m = findMember(String(req.params['id']));
    if (!m) {
      res.status(200).send(V.notFoundPage(t, String(req.params['id'])));
      return;
    }
    const data = {
      type: String(req.body['type'] ?? ''),
      nickname: String(req.body['nickname'] ?? ''),
      amount: String(req.body['amount'] ?? ''),
    };
    const seq = ++runtimeState.confirmationSeq;
    const confirmationNumber = `MC-${seq}`;
    const accountNumber = `0001${m.id}${String(seq).slice(-4)}`;
    res.send(V.confirmationPage(t, m, data, confirmationNumber, accountNumber));
  },
);

// Deliberately reachable by a human and deliberately *not* in the allowlist.
app.get('/t/:tenant/admin', withTenant, (req: TenantRequest, res) =>
  res.send(V.adminPage(T(req))),
);
app.post('/t/:tenant/admin/purge', withTenant, (_req, res) =>
  res.status(403).send('Refused. This endpoint exists only to prove the allowlist blocks it.'),
);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[target-app] Meridian Core (mock) listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[target-app] tenants: /t/northstar  /t/lakeshore`);
});
