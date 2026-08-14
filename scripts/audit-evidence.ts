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
