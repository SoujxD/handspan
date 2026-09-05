/**
 * Artifact safety audit.
 *
 * Reads a discovered capability and asserts the properties that must hold for
 * it to be safe to ship — the ones that are easy to claim in a write-up and
 * expensive to be wrong about:
 *
 *   - no credential survives as a literal
 *   - no element id is used as a matching signal (only as a forensic hint)
 *   - every state-changing step carries a checkpoint
 *   - nothing irreversible or confirmable can auto-retry
 *   - no PII value from the recording session is baked in
 *
 *   npx tsx scripts/verify-artifact.ts <capabilityId>
 */

import { CapabilityStore } from '../src/catalog/store.js';
import { PATHS } from '../src/config.js';
import { validateCapability } from '../src/types/artifact.js';
import { readFileSync } from 'node:fs';

const id = process.argv[2];
if (!id) { console.error('usage: npx tsx scripts/verify-artifact.ts <capabilityId>'); process.exit(2); }

const store = new CapabilityStore(PATHS.artifacts);
const cap = store.load(id);
const raw = JSON.stringify(cap);

const problems: string[] = [];
const checks: Array<[string, boolean, string]> = [];

const add = (name: string, ok: boolean, detail: string) => {
  checks.push([name, ok, detail]);
  if (!ok) problems.push(`${name}: ${detail}`);
};

// --- structural invariants -------------------------------------------------
const structural = validateCapability(cap);
add('structural invariants', structural.length === 0, structural.join('; ') || 'all pass');

// --- credentials -----------------------------------------------------------
const demoPwd = process.env.DEMO_PASSWORD ?? 'demo-pass-1234';
add('no literal password in artifact', !raw.includes(demoPwd), raw.includes(demoPwd) ? 'FOUND the demo password' : 'absent');

const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
add('no API key in artifact', !apiKey || !raw.includes(apiKey), 'absent');

// --- PII from the recording session ---------------------------------------
for (const [label, value] of [['SSN', '412-88-7301'], ['email', 'dana.whitfield@example.test'], ['balance', '18,432.07']] as const) {
  add(`no recorded ${label} baked in`, !raw.includes(value), raw.includes(value) ? `FOUND ${value}` : 'absent');
}

/**
 * PII from the recording session, checked STRUCTURALLY.
 *
 * The three literals above are the fixture app's seed values. Against any other
 * target that check is vacuous — it passed every MERIDIAN capability while three
 * of them carried `Member 102777 - Johnson, Katherine` in a match signal and in
 * the prose that reaches the logs. A detector written from one application's
 * data is exactly the failure this project already had once.
 *
 * The general rule needs no list: a descriptor must not quote an input's
 * example value. An example is instance data by definition, so a field
 * containing one is describing a single member rather than a control — a
 * privacy problem and a reuse bug at the same time, since that container can
 * never match anyone else's screen.
 */
const instanceValues = cap.inputs
  .filter((p) => p.sensitivity !== 'secret' && p.example && String(p.example).length > 3)
  .map((p) => ({ name: p.name, value: String(p.example) }));

const quotingInstanceData: string[] = [];
for (const step of cap.steps) {
  const target = (step.act as { target?: Record<string, unknown> }).target;
  if (!target) continue;
  for (const field of ['container', 'name', 'label'] as const) {
    const v = target[field];
    if (typeof v !== 'string') continue;
    for (const iv of instanceValues) {
      if (v.includes(iv.value)) quotingInstanceData.push(`${step.id}.${field} quotes {${iv.name}}`);
    }
  }
}
add(
  'no descriptor quotes the recording session data',
  quotingInstanceData.length === 0,
  quotingInstanceData.length ? quotingInstanceData.join('; ') : `checked ${instanceValues.length} input example(s)`,
);

// --- element ids are hints only --------------------------------------------
let idsInMatchPosition = 0;
let idsAsHints = 0;
const walk = (n: unknown): void => {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { n.forEach(walk); return; }
  const o = n as Record<string, unknown>;
  if (typeof o.role === 'string' && 'hints' in o) {
    const hints = (o.hints ?? {}) as Record<string, unknown>;
    if (typeof hints.domId === 'string' && hints.domId) idsAsHints++;
    for (const f of ['name', 'label', 'container'] as const) {
      const v = o[f];
      if (typeof v === 'string' && /ctl00|MainForm|\$/.test(v)) idsInMatchPosition++;
    }
  }
  Object.values(o).forEach(walk);
};
walk(cap);
add('no element id used as a matching signal', idsInMatchPosition === 0, `${idsInMatchPosition} in match position, ${idsAsHints} recorded as forensic hints`);

// --- targeting quality -----------------------------------------------------
const targets = cap.steps.filter((s) => 'target' in s.act).length;
const withLabelOrName = cap.steps.filter((s) => 'target' in s.act && ((s.act as any).target.label || (s.act as any).target.name)).length;
add('every target identified semantically', targets === withLabelOrName, `${withLabelOrName}/${targets}`);

const ordinalOnly = cap.steps.filter((s) => {
  if (!('target' in s.act)) return false;
  const t = (s.act as any).target;
  return t.ordinal !== undefined && !t.label && !t.name;
}).length;
add('no target relies on position alone', ordinalOnly === 0, `${ordinalOnly} ordinal-only`);

// --- governance ------------------------------------------------------------
/**
 * Approval must trace to a named human.
 *
 * The property that matters is not "unapproved" — an artifact stuck in draft
 * forever is useless — it is that nothing reaches `approved` without a reviewer
 * attached. Discovery has no way to write `reviewedBy`; only the `approve`
 * command does. So an approved artifact with no reviewer means the pipeline
 * approved itself, which is the failure this check exists to catch.
 */
const approved = cap.governance.approval === 'approved';
add(
  'approval traceable to a reviewer',
  !approved || !!cap.governance.reviewedBy,
  approved ? `approved by ${cap.governance.reviewedBy ?? 'NOBODY — self-approved'}` : `approval=${cap.governance.approval}`,
);
add('content hash present', !!cap.provenance.contentHash, cap.provenance.contentHash ?? 'MISSING');

// --- contract completeness -------------------------------------------------
add('declares business outcomes', cap.outcomes.some((o) => o.classification === 'business'),
    cap.outcomes.map((o) => `${o.code}(${o.classification})`).join(', ') || 'NONE');
add('declares typed outputs', cap.outputs.length > 0, cap.outputs.map((o) => `${o.name}:${o.type}`).join(', ') || 'NONE');
add('declares typed inputs', cap.inputs.length > 0, cap.inputs.map((i) => `${i.name}:${i.type}/${i.sensitivity}`).join(', ') || 'NONE');

// --- report ----------------------------------------------------------------
console.log(`\n  Artifact audit — ${cap.id} v${cap.version}\n  ${'─'.repeat(88)}`);
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(42)} ${detail}`);
}
console.log(`  ${'─'.repeat(88)}`);
if (problems.length) { console.log(`\n  ${problems.length} problem(s).\n`); process.exit(1); }
console.log('\n  Artifact is safe to ship.\n');
