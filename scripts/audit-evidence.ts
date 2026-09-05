/**
 * Evidence PII audit.
 *
 * Greps every persisted evidence file for values that must never come to rest
 * on disk. This is the check that caught a real leak: an extracted balance was
 * registered for scrubbing as the string it was scraped from ("$55,023.10")
 * but stored as the coerced number 55023.1, and the redactor passed numbers
 * through untouched.
 *
 *   npx tsx scripts/audit-evidence.ts [evidenceDir]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../src/config.js';

/** Values from the seeded mock data that are regulated by classification. */
const FORBIDDEN: Array<[string, string]> = [
  ['412-88-7301', 'SSN (Whitfield)'],
  ['509-22-6614', 'SSN (Ibarra)'],
  ['221-40-9987', 'SSN (Raghunathan)'],
  ['333-19-4420', 'SSN (Vance)'],
  ['dana.whitfield@example.test', 'email'],
  ['marcus.ibarra@example.test', 'email'],
  [process.env.DEMO_PASSWORD ?? 'demo-pass-1234', 'console password'],
  [process.env.ANTHROPIC_API_KEY ?? '\u0000never', 'Anthropic API key'],

  // MERIDIAN CORE (the hosted target). Names and street addresses have no
  // reliable regex, so the redactor cannot catch them by pattern - they are
  // scrubbed because something *declared* them regulated: an artifact output
  // classified `pii`, or, before any artifact exists, the recon pass
  // registering them off the member record before its first write. Seeding
  // them here is what turns that from a claim into a check.
  //
  // Read from the live target, not remembered. Balances are deliberately NOT
  // seeded: they change between runs, so a hardcoded one rots into a check
  // that passes because it no longer matches anything.
  //
  // The same rot applies more slowly to everything else here. This host is
  // shared and mutable - other people run Update Member Information against
  // it, and member 101555's e-mail and address have already changed once
  // during this project. So treat this list for what it is: a REGRESSION
  // check against values known to have been rendered, not a proof that
  // nothing leaked.
  //
  // The actual guarantee is structural and lives elsewhere: values whose LABEL
  // says they are regulated are registered for scrubbing as each screen is
  // observed, before anything is written. That works on a member record this
  // file has never seen. A green audit here means "no known value escaped",
  // which is worth having and is not the same claim.
  ['Lovelace, Ada', 'member name (100234)'],
  ['22 Harbor Lane, Arlington', 'member address (100234)'],
  ['Turing, Alan', 'member name (100987)'],
  ['100 Test Ave, Springfield', 'member address (100987)'],
  ['Hopper, Grace', 'member name (101555)'],
  ['1 Compiler Way, Arlington', 'member address (101555)'],
  ['Johnson, Katherine', 'member name (102777)'],
  ['12 Example St, Springfield', 'member address (102777)'],
  ['Vaughan, Dorothy', 'member name (103001)'],
  ['58 Fortran Ave, Newport', 'member address (103001)'],
  ['grace.hopper@example.com', 'member email (101555)'],
  ['dorothy.vaughan+replay@example.com', 'member email (103001)'],
  // NOT seeded: MERIDIAN's demo operator password, whose literal value is the
  // word "password". Seeding it reported 41 leaks, every one an English
  // sentence ("Enter the operator's password on the sign-in screen").
  //
  // The lesson is about the instrument, not the threshold. A substring audit
  // can only check a secret that is distinguishable from prose, and this one
  // is not - so loosening the match would be pretending to check something.
  // The guarantee for that field comes from somewhere else and is stronger:
  // it is a `secret`-classified input, so its value is never shown to the
  // model, never captured into a snapshot, and never written to an artifact.
  // The audit checks values that could leak; classification stops this one
  // from being collected at all.
];

const root = process.argv[2] ?? PATHS.evidence;
const leaks: Array<{ file: string; what: string }> = [];
let filesScanned = 0;

function scan(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) { scan(p); continue; }
    if (/\.(png|jpg)$/i.test(entry)) continue; // images are masked at capture time
    filesScanned++;
    const txt = readFileSync(p, 'utf8');
    for (const [value, label] of FORBIDDEN) {
      if (value && value.length > 6 && txt.includes(value)) {
        leaks.push({ file: p.split('\\').join('/'), what: label });
      }
    }
  }
}

scan(root);

console.log(`\n  Evidence PII audit — ${filesScanned} file(s) under ${root}\n  ${'─'.repeat(76)}`);
if (leaks.length === 0) {
  console.log('  CLEAN — no regulated value found in any persisted evidence file.\n');
  process.exit(0);
}
for (const l of leaks) console.log(`  LEAK  ${l.what.padEnd(22)} ${l.file}`);
console.log(`\n  ${leaks.length} leak(s).\n`);
process.exit(1);
