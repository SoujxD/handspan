/**
 * List a member's OPEN shares. A demo convenience, not part of the system.
 *
 * The host is shared with other candidates and its state moves under you: a
 * share that was open this morning may be on HOLD by the afternoon, and a
 * transfer from a held share correctly returns the `source_share_on_hold`
 * business outcome rather than a confirmation number. That is the system
 * working, but it is not the beat you want to open a demo with.
 *
 * So this answers one question before you start: which of this member's shares
 * can actually be debited right now. It talks plain HTTP rather than driving
 * the browser, because it is scaffolding for a person, not a capability — the
 * things a capability must guarantee (no selectors, typed contract, evidence,
 * redaction) would all be dead weight here, and pretending otherwise would
 * blur the line this project is about.
 *
 *   npx tsx scripts/open-shares.ts [memberNumber]
 */

import { requireInstitution } from '../src/config.js';

const member = process.argv[2] ?? '100234';
const institution = requireInstitution(process.env['MERIDIAN_TENANT'] ?? 'meridian-demo');
const base = institution.baseUrl;

const operator = process.env['HANDSPAN_INPUT_OPERATOR_ID'] ?? 'teller1';
const password = process.env['HANDSPAN_INPUT_OPERATOR_PASSWORD'];
if (!password) {
  console.error(
    'HANDSPAN_INPUT_OPERATOR_PASSWORD is not set. Copy .env.example to .env and fill it in.',
  );
  process.exit(2);
}

/** Keep the session cookie by hand; there is no cookie jar in fetch. */
let cookie = '';
async function get(path: string): Promise<string> {
  const res = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  return res.text();
}

await get('/signon');
const signon = await fetch(`${base}/signon`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams({ operator, password }).toString(),
  redirect: 'manual',
});
const set = signon.headers.get('set-cookie');
if (set) cookie = set.split(';')[0]!;
if (signon.status !== 302) {
  console.error(`Sign-on as "${operator}" was rejected (HTTP ${signon.status}).`);
  process.exit(1);
}

const html = await get(`/members/${member}`);

const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) =>
  [...m[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]!.replace(/<[^>]*>/g, ' ').trim()),
);

const open = rows.filter(
  (c) => c.length >= 4 && c[0]!.startsWith(`${member}-`) && /^OPEN/.test(c[3]!),
);

if (!open.length) {
  console.error(`\n  Member ${member} has no OPEN shares right now. Try another seed member:`);
  console.error('  100234, 100987, 101555, 102777, 103001\n');
  process.exit(1);
}

console.log(`\n  Member ${member} — ${open.length} OPEN share(s), most funded first\n`);
const amount = (s: string): number => Number(s.replace(/[$,]/g, '')) || 0;
for (const c of [...open].sort((a, b) => amount(b[2]!) - amount(a[2]!))) {
  console.log(`  ${c[0]!.padEnd(20)} ${c[2]!.padStart(12)}   ${c[1]}`);
}

const best = [...open].sort((a, b) => amount(b[2]!) - amount(a[2]!));
if (best.length >= 2) {
  console.log(
    `\n  Ready to paste:\n    -i fromShareOption=${best[0]![0]} -i toShareOption=${best[1]![0]}\n`,
  );
}
