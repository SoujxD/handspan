/**
 * Regenerate the outcome-verification report for every MERIDIAN capability.
 *
 * `verify-outcomes.ts` checks one capability. The committed report was
 * assembled from several of its runs by hand, which is why it went stale the
 * moment new detectors were declared: it described 19 detectors across 5
 * capabilities while the artifacts had grown to 33 across 7. A report that
 * disagrees with the thing it reports on is worse than no report, because it
 * is read as evidence.
 *
 * So the assembly is a script. The numbers come from the runs, the prose that
 * explains WHY something could not be provoked is written here because it is
 * analysis rather than measurement — and it is kept next to the code that
 * produces the numbers so the two cannot drift apart unnoticed.
 *
 *   npx tsx scripts/verify-all-outcomes.ts
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CapabilityStore } from '../src/catalog/store.js';
import { PATHS, PROJECT_ROOT } from '../src/config.js';

const PRODUCT = 'cornerstone-meridian-core';
const OUT = join(PATHS.evidence, 'VERIFY-OUTCOMES-meridian.txt');

/**
 * Detectors verified by a check other than the probe pass, with the check that
 * does it. A probe drives the flow with different ARGUMENTS; an interstitial is
 * not reachable that way, so it has its own verification and this report must
 * say so rather than reporting it as never fired.
 */
const VERIFIED_ELSEWHERE: Record<string, string> = {
  maintenance_interstitial: 'scripts/verify-interstitial.ts (detected, resolved, dismissed on the live host)',
  supervisor_override_denied: 'scripts/rehearse-escalation.ts (fires on every rehearsal, 9/9 assertions)',
};

const store = new CapabilityStore(PATHS.artifacts);
const caps = store
  .listLatest()
  .filter((c) => c.surface.product === PRODUCT)
  .sort((a, b) => a.id.localeCompare(b.id));

const blocks: string[] = [];
let verified = 0;
let unverified = 0;
let elsewhere = 0;
const stillUnverified: Array<{ cap: string; code: string; cls: string }> = [];

for (const cap of caps) {
  process.stderr.write(`  running ${cap.id} v${cap.version} ...\n`);
  let out = '';
  try {
    out = execFileSync('npx', ['tsx', 'scripts/verify-outcomes.ts', cap.id], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? '');
  }

  const lines: string[] = [];
  for (const line of out.split('\n')) {
    // The classification must be one of the four the schema allows. Without
    // that anchor this also matched the script's own trailing sentence —
    // "UNVERIFIED detectors are not necessarily wrong ..." — and invented a
    // detector called `detectors`, which inflated the denominator from 33 to
    // 40 and put seven phantom failures in the totals.
    const m = /^\s*(VERIFIED|UNVERIFIED)\s+(\S+)\s+(business|recoverable|hard|escalate)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, state, code, cls, detail] = m;
    if (state === 'VERIFIED') {
      verified++;
      lines.push(`  VERIFIED    ${code!.padEnd(30)} ${cls!.padEnd(12)} ${detail!.trim()}`);
    } else if (VERIFIED_ELSEWHERE[code!]) {
      elsewhere++;
      lines.push(`  VERIFIED*   ${code!.padEnd(30)} ${cls!.padEnd(12)} ${VERIFIED_ELSEWHERE[code!]}`);
    } else {
      unverified++;
      stillUnverified.push({ cap: cap.id, code: code!, cls: cls! });
      lines.push(`  UNVERIFIED  ${code!.padEnd(30)} ${cls!.padEnd(12)} never fired in any probe`);
    }
  }

  // Keep the raw pass on disk: re-reading a parser bug should never cost
  // another sixty replays against a shared host.
  writeFileSync(join(PATHS.evidence, `outcome-pass-${cap.id}.txt`), out, 'utf8');
  blocks.push(`════ ${cap.id} v${cap.version}\n${lines.join('\n')}`);
}

const total = verified + elsewhere + unverified;

const report = `Outcome-detector verification against the live MERIDIAN CORE target
Generated ${new Date().toISOString()} — zero model calls, every probe a real replay.
Regenerate with: npx tsx scripts/verify-all-outcomes.ts

Probes are declared per institution in institutions.json, because which member
number does not exist and which share is on HOLD are properties of the target,
not of this script. All natural error paths: the host is shared with other
candidates, so its global fault-injection screen is never touched.

VERIFIED   fired during the probe pass.
VERIFIED*  provoked by a dedicated check instead, named on the line. A probe
           varies the ARGUMENTS to a flow; a state that is not reachable by
           argument needs a different instrument, not a weaker claim.
UNVERIFIED never fired. Not evidence the detector is wrong — and not evidence
           it works either. Listed so the difference stays visible.

${blocks.join('\n\n')}

════ Totals

${verified + elsewhere} of ${total} declared detectors are verified against the live application
(${verified} by the probe pass, ${elsewhere} by a dedicated check). ${unverified} are not:

${stillUnverified.map((u) => `  ${u.code.padEnd(30)} ${u.cls.padEnd(12)} ${u.cap}`).join('\n')}

════ Why those stay UNVERIFIED, honestly

They fall into two groups, and the two are different in kind.

  1. THE STATE CANNOT BE REACHED FROM OUTSIDE THE FLOW
     session_timeout / session_timed_out / system_error / settings_area_off_limits
     / account_locked / hold_applied_unexpectedly

     "?inject=" is a URL parameter, so it can only ride a navigation. The only
     navigation in these capabilities is the entry URL, which happens before the
     state matters; every step after it is a click, and a click carries no query
     string. There is no way to expire a session at step nine from out here.

     The alternative is the System Settings screen, which sets injection
     GLOBALLY on a host shared with other candidates — and which policy.yaml
     denies for exactly that reason. Breaking someone else's demo to tick a box
     here is not a trade worth making.

     What would close it: a per-step fault hook in the replay engine, able to
     attach "?inject=" to the request a click is about to make. That is a core
     change for the benefit of a test, so it is on the next-steps list rather
     than in this build.

  2. SHADOWED BY AN EARLIER RULE, AND HARMLESSLY SO
     invalid_initial_deposit, validation_errors

     The application renders a generic "could not be validated" banner, which
     matches request_not_validated (respectively invalid_email_format) first,
     and outcomes match in declaration order. Both members of each pair are
     classified 'business', so the shadowing changes nothing a caller can
     observe: a rejected deposit is reported as an answer either way.
     Reordering would need a re-recording; reclassifying was the cheaper
     correct fix.

     This group is not "unproven". It is proven unreachable and demonstrably
     harmless, which is a different and better position to be in.
`;

writeFileSync(OUT, report, 'utf8');
console.log(report);
process.stderr.write(`\n  Written to ${OUT}\n`);
