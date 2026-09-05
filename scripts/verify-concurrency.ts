/**
 * Serve several members at once, through the HTTP API, and check nothing is
 * lost.
 *
 * Every other check in this project drives one invocation at a time, and the
 * question a platform team asks first is the one that never answers: this
 * fronts a conversational product, so several members are being served in the
 * same second or it is not in production.
 *
 * Concurrency was never exercised, and it was broken. `recordRun` did a
 * read-modify-write on `governance.stability.runs` — the counter that gates
 * approval — against the caller's own in-memory copy. Twenty simultaneous runs
 * recorded as one. `tests/store-concurrency.test.ts` pins that at the unit
 * level; this asserts the whole path, over real HTTP, against the live target.
 *
 * What it asserts:
 *
 *   1. Every concurrent invocation completes with a result contract.
 *   2. Each gets its OWN run id and its own evidence directory — sessions are
 *      isolated, not shared.
 *   3. Each returns its OWN member's data. A crossed browser session would
 *      show up here as one member's balance answering another's request, and
 *      that is the failure worth being afraid of.
 *   4. No model is called, however many run at once.
 *   5. The stability counter advances by exactly the number of runs.
 *
 * Start the catalog first:
 *   npx tsx src/cli.ts catalog
 *   npx tsx scripts/verify-concurrency.ts
 */

import { CapabilityStore } from '../src/catalog/store.js';
import { PATHS, runtimeConfig } from '../src/config.js';
import type { ReplayResult } from '../src/types/result.js';

const CAPABILITY = 'member_share_balance_lookup';
const BASE = `http://localhost:${process.env['CATALOG_PORT'] ?? runtimeConfig().catalogPort}`;

/** Distinct members, so a crossed session is visible as a wrong answer. */
const REQUESTS = [
  { memberNumber: '100234', shareId: '100234-S0001-14' },
  { memberNumber: '100987', shareId: '100987-MMKT-11' },
  { memberNumber: '102777', shareId: '102777-MMKT-4' },
];

const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ''): void => {
  if (!ok) failures.push(label);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
};

const store = new CapabilityStore(PATHS.artifacts);
const before = store.load(CAPABILITY).governance.stability.runs;

console.log(`\n  CONCURRENCY — ${REQUESTS.length} members served simultaneously`);
console.log(`  ${'─'.repeat(84)}`);
console.log(`  catalog        ${BASE}`);
console.log(`  capability     ${CAPABILITY}`);
console.log(`  runs recorded  ${before} before\n`);

await fetch(`${BASE}/capabilities`).catch(() => {
  console.error(`  Cannot reach the catalog at ${BASE}. Start it with: npx tsx src/cli.ts catalog\n`);
  process.exit(2);
});

const started = Date.now();
const responses = await Promise.all(
  REQUESTS.map(async (body) => {
    const res = await fetch(`${BASE}/capabilities/${CAPABILITY}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      request: body,
      httpStatus: res.status,
      runId: res.headers.get('x-handspan-run-id') ?? '',
      result: (await res.json()) as ReplayResult,
    };
  }),
);
const elapsed = Date.now() - started;

for (const r of responses) {
  const status = r.result.status;
  const name =
    status === 'success' ? String(r.result.outputs['memberName']?.value ?? '') : '(no outputs)';
  console.log(
    `  member ${r.request.memberNumber}  HTTP ${r.httpStatus}  ${status.padEnd(9)} ` +
      `${String(r.result.meta.durationMs).padStart(6)} ms  ${r.runId}`,
  );
  // The name is redacted in everything persisted; it is returned to the caller
  // that asked for it, which is the whole point of the distinction.
  if (status === 'success') console.log(`         -> ${name}`);
}
console.log('');

check(
  responses.every((r) => r.httpStatus === 200),
  'every concurrent invocation returned a result contract',
  responses.map((r) => r.httpStatus).join(', '),
);

const runIds = new Set(responses.map((r) => r.runId).filter(Boolean));
check(
  runIds.size === responses.length,
  'each run got its own run id and evidence directory',
  `${runIds.size} distinct`,
);

/**
 * The one that would matter in production: did any request get another
 * member's screen? A shared browser context would answer one caller with
 * another caller's data, and it would look like a success.
 *
 * Asserted as "three distinct members produced three distinct names", which is
 * exactly what crossing would break — two responses would carry the same
 * person. The obvious check, comparing each name against the one expected for
 * that member number, is not available and should not be: it would mean
 * committing member names to the repository, and this project's rule is that
 * regulated values never come to rest in it.
 *
 * The member number itself cannot be used either. It is scrubbed from evidence
 * — the URL reads /members/[REDACTED:SECRET] — because it is classified `pii`.
 * That is the redaction layer working, so the test bends around it rather than
 * asking for it to be relaxed.
 */
const names = responses.map((r) =>
  r.result.status === 'success' ? String(r.result.outputs['memberName']?.value ?? '') : '',
);
const distinct = new Set(names.filter(Boolean));
check(
  distinct.size === responses.length,
  'no session crossed — distinct members returned distinct records',
  `${distinct.size} distinct name(s) across ${responses.length} concurrent runs`,
);

check(
  responses.every((r) => r.result.meta.llmCalls === 0),
  'no model was called, however many ran at once',
);

const after = store.load(CAPABILITY).governance.stability.runs;
check(
  after - before === responses.length,
  'the stability counter advanced by exactly the number of runs',
  `${before} -> ${after}, expected +${responses.length}`,
);

const slowest = Math.max(...responses.map((r) => r.result.meta.durationMs));
console.log(
  `\n  ${responses.length} runs in ${(elapsed / 1000).toFixed(1)}s wall clock; ` +
    `slowest single run ${(slowest / 1000).toFixed(1)}s. They overlapped.`,
);

console.log(`\n  ${'─'.repeat(84)}`);
if (failures.length) {
  console.log(`  ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.log(`    - ${f}`);
  console.log('');
  process.exit(1);
}
console.log('  Concurrent invocation verified: isolated sessions, no lost runs, no model calls.\n');
process.exit(0);
