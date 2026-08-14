/**
 * Perception smoke check.
 *
 * Not a unit test — it drives the real browser against the real mock app and
 * prints what the model would see. Kept in the repo because "what does the
 * agent actually perceive" is the question you need answered first when a
 * capability misbehaves, and reading a JSON snapshot after the fact is slower
 * than looking at it live.
 *
 *   npx tsx tests/smoke-perception.ts [tenant]
 */

import { PlaywrightSurface } from '../src/surface/web/playwright-surface.js';
import { SessionLease } from '../src/control/lease.js';
import { resolve } from '../src/surface/web/resolver.js';
import { runtimeConfig } from '../src/config.js';

const tenant = process.argv[2] ?? 'northstar';
const cfg = runtimeConfig();
const base = `${cfg.targetAppBase}/t/${tenant}`;

const lease = new SessionLease('smoke');
const surface = await PlaywrightSurface.launch({ lease, headless: true });

function show(label: string, nodes: Awaited<ReturnType<typeof surface.snapshot>>['nodes']): void {
  console.log(`\n=== ${label} ===`);
  for (const n of nodes) {
    if (n.role === 'cell' && !n.value) continue;
    const bits = [n.handle.padEnd(5), n.role.padEnd(9)];
    if (n.name) bits.push(`name="${n.name}"`);
    if (n.label && n.label !== n.name) bits.push(`label="${n.label}"(${n.labelSource})`);
    if (n.value) bits.push(`value="${n.value.slice(0, 40)}"`);
    if (n.container) bits.push(`in="${n.container}"`);
    if (n.rowKey) bits.push(`row="${n.rowKey}"`);
    if (n.columnHeader) bits.push(`col="${n.columnHeader}"`);
    if (n.framePath.length) bits.push(`frame=${n.framePath.join('/')}`);
    console.log('  ' + bits.join('  '));
  }
}

try {
  // --- login screen ---------------------------------------------------------
  await surface.act({ kind: 'navigate', url: `${base}/login` });
  let snap = await surface.snapshot();
  show('LOGIN', snap.nodes);

  // The password field has no <label for>; its only label is the adjacent cell.
  // If this resolves, the derivation ladder is doing its job.
  const pwd = resolve(
    {
      description: 'password box labelled Password',
      role: 'textbox',
      label: 'Password',
      nameMatch: 'normalized',
      labelMatch: 'normalized',
      framePath: [],
      hints: {},
    },
    snap.nodes,
  );
  console.log(
    `\n  resolve(textbox labelled "Password") -> ${pwd.ok ? `OK handle=${pwd.node.handle} score=${Math.round(pwd.score)} signals=${pwd.matchedSignals.join(',')}` : `FAILED (${pwd.reason})`}`,
  );

  // --- sign in and walk the flow -------------------------------------------
  const user = resolve(
    { description: 'User ID', role: 'textbox', label: 'User ID', nameMatch: 'normalized', labelMatch: 'normalized', framePath: [], hints: {} },
    snap.nodes,
  );
  if (!user.ok || !pwd.ok) throw new Error('login fields not resolvable');

  await surface.act({ kind: 'type', handle: user.node.handle, text: 'teller01', clearFirst: true });
  snap = await surface.snapshot();
  const pwd2 = resolve(
    { description: 'Password', role: 'textbox', label: 'Password', nameMatch: 'normalized', labelMatch: 'normalized', framePath: [], hints: {} },
    snap.nodes,
  );
  if (!pwd2.ok) throw new Error('password not resolvable after re-snapshot');
  await surface.act({ kind: 'type', handle: pwd2.node.handle, text: 'demo-pass-1234', clearFirst: true });

  snap = await surface.snapshot();
  const btn = resolve(
    { description: 'Sign In button', role: 'button', name: 'Sign In', nameMatch: 'normalized', labelMatch: 'normalized', framePath: [], hints: {} },
    snap.nodes,
  );
  if (!btn.ok) throw new Error('sign-in button not resolvable');
  await surface.act({ kind: 'click', handle: btn.node.handle });

  snap = await surface.snapshot();
  console.log(`\n  after login -> ${snap.url}`);
  show('AFTER LOGIN (note frame path)', snap.nodes);

  // --- member detail: the grid read ----------------------------------------
  await surface.act({ kind: 'navigate', url: `${base}/member/12345` });
  snap = await surface.snapshot();
  show('MEMBER DETAIL', snap.nodes);

  const savingsBalance = snap.nodes.find(
    (n) => n.role === 'cell' && n.rowKey === '000123450001' && n.columnHeader === 'Current Balance',
  );
  console.log(`\n  grid read (row 000123450001 x col "Current Balance") -> ${savingsBalance?.value ?? 'NOT FOUND'}`);

  const typeCell = snap.nodes.find((n) => n.role === 'cell' && n.columnHeader === 'Type' && n.value === 'SAVINGS');
  console.log(`  SAVINGS row key -> ${typeCell?.rowKey ?? 'NOT FOUND'}`);
} finally {
  await surface.close();
}
