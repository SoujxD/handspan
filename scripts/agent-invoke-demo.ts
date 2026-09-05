/**
 * Agent-facing capability interface (stretch goal §8).
 *
 * Shows a calling agent doing the two things it needs to do:
 *   1. DISCOVER — fetch the catalog and get back function-calling tool
 *      definitions it can drop straight into its `tools` array.
 *   2. INVOKE  — call one by name with typed args and switch on the result.
 *
 * The point is how little code this is. Because the artifact already carries a
 * typed contract — inputs, outputs, business outcomes, risk, approval state —
 * projecting it into a tool definition is mechanical. The agent never learns
 * that a browser was involved.
 *
 *   npm run catalog                                  # in one terminal
 *   npx tsx scripts/agent-invoke-demo.ts <capId>     # in another
 */

import { runtimeConfig } from '../src/config.js';

const capabilityId = process.argv[2];
const memberId = process.argv[3] ?? '12345';
const cfg = runtimeConfig();
const CATALOG = `http://localhost:${cfg.catalogPort}`;

const hr = () => console.log(`  ${'─'.repeat(88)}`);

// --- 1. discovery -----------------------------------------------------------
console.log('\n  1. Agent discovers available capabilities\n');
hr();

// `product=all`: this demo drives the take-home fixture, and the catalog now
// scopes its listing to the product it fronts (MERIDIAN CORE) so an agent is
// not offered a tool from a different application.
const catalog = (await fetch(`${CATALOG}/capabilities?product=all`).then((r) => r.json())) as {
  count: number;
  tools: Array<Record<string, any>>;
};

console.log(`  GET /capabilities  ->  ${catalog.count} capability(ies)\n`);

for (const t of catalog.tools) {
  console.log(`  name:        ${t.name}`);
  console.log(`  description: ${String(t.description).split('\n')[0]}`);
  console.log(`  required:    ${t.input_schema.required.join(', ')}`);
  console.log(`  risk:        ${t.handspan.maxRisk}   approval: ${t.handspan.approval}   confirm required: ${t.handspan.requiresConfirmation}`);
  console.log(`  returns:     ${t.handspan.returns.map((r: any) => `${r.name}:${r.type}(${r.sensitivity})`).join(', ') || '—'}`);
  const business = t.handspan.outcomes.filter((o: any) => o.classification === 'business');
  console.log(`  outcomes:    ${business.map((o: any) => o.code).join(', ') || '—'}`);
  console.log(`  stability:   ${t.handspan.stability.successes}/${t.handspan.stability.runs}`);
  console.log('');
}

const target = capabilityId ?? catalog.tools[0]?.name;
if (!target) {
  console.error('  No capabilities in the catalog. Run a discovery first.');
  process.exit(1);
}

// --- 2. invocation ----------------------------------------------------------
async function invoke(label: string, body: Record<string, unknown>): Promise<void> {
  console.log(`\n  ${label}`);
  hr();
  console.log(`  POST /capabilities/${target}/invoke  ${JSON.stringify(masked(body))}`);

  const res = await fetch(`${CATALOG}/capabilities/${target}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const r = (await res.json()) as any;

  console.log(`  HTTP ${res.status}   status="${r.status}"   model calls: ${r.meta?.llmCalls ?? 'n/a'}`);

  // This switch is the whole reason the result contract has four shapes: a
  // caller cannot accidentally treat a business outcome as an error.
  switch (r.status) {
    case 'success':
      console.log('  -> The agent got its data:');
      for (const [k, v] of Object.entries(r.outputs as Record<string, any>)) {
        console.log(`       ${k} = ${v.value}${v.redacted ? `  (redacted: ${v.sensitivity})` : ''}`);
      }
      break;
    case 'outcome':
      console.log(`  -> Business outcome "${r.outcome}" — ${r.outcomeTitle}`);
      console.log('     HTTP 200 and a valid answer. A caller retrying on non-2xx must NOT retry this.');
      break;
    case 'escalated':
      console.log(`  -> Parked on a human: ${r.reason}`);
      console.log(`     ${r.operatorUrl}`);
      break;
    case 'failure':
      console.log(`  -> Failure (${r.failure.kind}): ${r.failure.message}`);
      if (r.failure.expected) console.log(`     expected: ${r.failure.expected}`);
      if (r.failure.observed) console.log(`     observed: ${r.failure.observed}`);
      if (r.failure.remediation) console.log(`     fix:      ${r.failure.remediation}`);
      break;
    default:
      console.log(`  -> ${JSON.stringify(r).slice(0, 300)}`);
  }
}

const tool = catalog.tools.find((t) => t.name === target);
const member = memberIdParam(tool);

// A real lookup.
await invoke('2. Agent invokes the capability with typed args', {
  ...args(tool),
  [member]: memberId,
});

// A lookup that legitimately has no answer.
await invoke('3. Same capability, an input with no matching record', {
  ...args(tool),
  [member]: '99999',
});

console.log('');

/**
 * A secret is a secret on the way in as well as on the way out.
 *
 * The engine scrubs credentials from anything it persists, but this script is
 * the *caller* — it holds the plaintext password and would otherwise print it
 * to a terminal that routinely gets pasted into a ticket. Masking here is the
 * same rule applied at the only place the engine cannot reach.
 */
function masked(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    out[k] = /pass|pwd|secret|token/i.test(k) ? '••••••••' : v;
  }
  return out;
}

/**
 * Which required parameter carries the member number.
 *
 * `tenantId` also ends in "Id", so a naive /id/ match binds the member number
 * to the tenant and the whole invocation fails on an unknown institution —
 * which is exactly what this script did until the demo was actually run. Match
 * on the domain noun, not on the suffix.
 */
function memberIdParam(t: Record<string, any> | undefined): string {
  const names: string[] = t?.input_schema?.required ?? [];
  return (
    names.find((n) => /^member/i.test(n)) ??
    names.find((n) => /member/i.test(n)) ??
    'memberId'
  );
}

/**
 * Fill every required argument from the published schema.
 *
 * Credentials come from the environment; everything else uses the `examples`
 * the artifact carries. That is the point of publishing them: an agent holding
 * only the tool definition can construct a valid call without being told the
 * shape of the institution's data out of band.
 */
function args(t: Record<string, any> | undefined): Record<string, unknown> {
  const props: Record<string, any> = t?.input_schema?.properties ?? {};
  const out: Record<string, unknown> = {};

  for (const n of (t?.input_schema?.required ?? []) as string[]) {
    const p = props[n] ?? {};
    if (/user|login/i.test(n)) out[n] = process.env['DEMO_USERNAME'] ?? 'teller01';
    else if (/pass|pwd|secret/i.test(n)) out[n] = process.env['DEMO_PASSWORD'] ?? 'demo-pass-1234';
    else if (p.enum?.length) out[n] = p.enum[0];
    else if (p.examples?.length) out[n] = p.type === 'number' ? Number(p.examples[0]) : p.examples[0];
  }

  // A state-committing capability refuses to run unattended without an explicit
  // acknowledgement. Sending it here is the agent saying "yes, I meant it".
  if (t?.handspan?.requiresConfirmation) out['confirm'] = t.name;
  return out;
}
