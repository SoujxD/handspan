/**
 * Safety tests: allowlist, risk classification, and redaction.
 *
 * These are the tests that would fail loudly if someone "simplified" the
 * guardrails, which is exactly what you want from a safety layer. The
 * redaction tests in particular assert the *guarantee* (a registered secret
 * cannot survive) rather than the heuristic (a regex catches SSN shapes),
 * because only the former is something to rely on.
 */

import { describe, expect, it } from 'vitest';
import { PolicyEngine, pathMatches, type PolicyFile } from '../src/safety/policy.js';
import { Redactor } from '../src/safety/redaction.js';
import { loadPolicy } from '../src/config.js';

const policy = loadPolicy();

describe('pathMatches', () => {
  it('matches :param segments', () => {
    expect(pathMatches('/t/:tenant/member/:id', '/t/northstar/member/12345')).toBe(true);
  });

  it('does not let a :param swallow extra segments', () => {
    // The failure this prevents: /member/:id matching /member/1/admin and
    // letting an agent walk into an admin route through a "permitted" pattern.
    expect(pathMatches('/t/:tenant/member/:id', '/t/northstar/member/12345/admin')).toBe(false);
  });

  it('requires a non-empty value for a :param', () => {
    expect(pathMatches('/t/:tenant/member/:id', '/t/northstar/member/')).toBe(false);
  });

  it('supports :rest for whole-subtree denials', () => {
    expect(pathMatches('/t/:tenant/admin/:rest', '/t/northstar/admin/users/delete')).toBe(true);
  });
});

describe('navigation allowlist', () => {
  it('permits a route on the allowlist', () => {
    expect(policy.checkNavigation('http://localhost:4300/t/northstar/member/12345').allow).toBe(true);
  });

  it('denies a foreign origin', () => {
    const d = policy.checkNavigation('http://evil.example.com/t/northstar/member/12345');
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/allowlist/i);
  });

  it('denies an explicitly denied path even though its origin is allowed', () => {
    const d = policy.checkNavigation('http://localhost:4300/t/northstar/admin');
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.risk).toBe('irreversible');
  });

  it('denies an unlisted route on an allowed origin (allowlist, not blocklist)', () => {
    expect(policy.checkNavigation('http://localhost:4300/t/northstar/something/new').allow).toBe(false);
  });

  it('denies a non-absolute URL rather than guessing a base', () => {
    expect(policy.checkNavigation('/t/northstar/member/12345').allow).toBe(false);
  });
});

describe('risk classification', () => {
  it('treats a plain navigation link as safe', () => {
    expect(policy.classify({ kind: 'click', targetName: 'Member Servicing' })).toBe('safe');
  });

  it('classifies a state-committing button as confirmable', () => {
    expect(policy.classify({ kind: 'click', targetName: 'Confirm and Open Account' })).toBe('confirmable');
  });

  it('classifies a destructive button as irreversible', () => {
    expect(policy.classify({ kind: 'click', targetName: 'Purge Member Records' })).toBe('irreversible');
  });

  it('classifies on the container as well as the control', () => {
    // "Delete" alone is obvious; the point is that context is judged too.
    expect(policy.classify({ kind: 'click', targetName: 'OK', targetContainer: 'Delete Member' })).toBe(
      'irreversible',
    );
  });

  it('classifies typing into a credential field as sensitive', () => {
    expect(policy.classify({ kind: 'type', fieldLabel: 'Password' })).toBe('sensitive');
    expect(policy.classify({ kind: 'type', fieldLabel: 'Tax ID' })).toBe('sensitive');
    expect(policy.classify({ kind: 'type', fieldLabel: 'Account Nickname' })).toBe('safe');
  });
});

describe('risk gating', () => {
  const irreversible = { kind: 'click' as const, targetName: 'Purge Member Records' };
  const confirmable = { kind: 'click' as const, targetName: 'Confirm and Open Account' };

  it('blocks an irreversible action even when attended', () => {
    expect(policy.evaluate(irreversible, { mode: 'attended' }).allow).toBe(false);
  });

  it('blocks an irreversible action even with a confirmation token', () => {
    // There is no token that authorises an irreversible action unattended.
    // If there were, it would eventually be passed by default.
    const d = policy.evaluate(irreversible, {
      mode: 'unattended',
      confirmationToken: 'anything',
      capabilityId: 'anything',
    });
    expect(d.allow).toBe(false);
  });

  it('blocks a confirmable action unattended with no token', () => {
    expect(policy.evaluate(confirmable, { mode: 'unattended', capabilityId: 'open_sub_account' }).allow).toBe(
      false,
    );
  });

  it('allows a confirmable action unattended with a matching token', () => {
    const d = policy.evaluate(confirmable, {
      mode: 'unattended',
      confirmationToken: 'open_sub_account',
      capabilityId: 'open_sub_account',
    });
    expect(d.allow).toBe(true);
  });

  it('rejects a token issued for a different capability', () => {
    // Stops a token being harvested from one flow and replayed against another.
    const d = policy.evaluate(confirmable, {
      mode: 'unattended',
      confirmationToken: 'read_balance',
      capabilityId: 'open_sub_account',
    });
    expect(d.allow).toBe(false);
  });

  it('allows a confirmable action when a human is watching', () => {
    expect(policy.evaluate(confirmable, { mode: 'attended' }).allow).toBe(true);
  });

  it('denies an action kind that is not on the allowlist', () => {
    const file = policy.file as PolicyFile;
    expect(file.actions.denied).toContain('execute_script');
    const engine = new PolicyEngine(file);
    expect(engine.evaluate({ kind: 'execute_script' as never }, { mode: 'attended' }).allow).toBe(false);
  });
});

describe('redaction', () => {
  it('removes a registered secret even when no pattern matches it', () => {
    // The guarantee, as opposed to the heuristic. "hunter2-correct-horse"
    // matches no regex; it must still be impossible to log.
    const r = new Redactor([]);
    r.registerSecret('hunter2-correct-horse');
    expect(r.text('logging in with hunter2-correct-horse now')).not.toContain('hunter2');
  });

  it('refuses to register a value too short to scrub safely', () => {
    // Registering "a" would scrub every 'a' in every log line and destroy the
    // evidence trail while appearing to work.
    const r = new Redactor([]);
    r.registerSecret('ab');
    expect(r.secretCount).toBe(0);
  });

  it('redacts SSN-shaped values found in page text', () => {
    const r = new Redactor(policy.file.redaction.patterns);
    expect(r.text('Tax ID 412-88-7301')).toBe('Tax ID [REDACTED:SSN]');
  });

  it('redacts an SSN with no separator before it', () => {
    // Regression, and a real leak. Legacy screens concatenate a label and its
    // value ("Tax ID412-88-7301"), and a `\b`-anchored pattern cannot match
    // between "D" and "4" — there is no word boundary there. The digit-boundary
    // form catches it.
    const r = new Redactor(policy.file.redaction.patterns);
    expect(r.text('Tax ID412-88-7301')).not.toContain('412-88-7301');
    expect(r.text('DOB1979-04-11 Tax ID412-88-7301')).toContain('[REDACTED:SSN]');
  });

  it('still does not match an SSN shape inside a longer digit run', () => {
    // The digit-boundary anchors have to keep this from over-matching an
    // account number that merely contains the shape.
    const r = new Redactor(policy.file.redaction.patterns);
    expect(r.text('ref 9412-88-73011')).toContain('9412-88-73011');
  });

  it('redacts a field by key name regardless of its value', () => {
    const r = new Redactor(policy.file.redaction.patterns);
    const out = r.value({ password: 'zzz', note: 'fine' });
    expect(out.password).toBe('[REDACTED:FIELD]');
    expect(out.note).toBe('fine');
  });

  it('redacts nested structures, not just top-level fields', () => {
    const r = new Redactor(policy.file.redaction.patterns);
    const out = r.value({ step: { observed: { pageText: 'SSN 412-88-7301 on file' } } });
    expect(JSON.stringify(out)).toContain('[REDACTED:SSN]');
    expect(JSON.stringify(out)).not.toContain('412-88-7301');
  });

  it('never emits an Anthropic key', () => {
    const r = new Redactor(policy.file.redaction.patterns);
    expect(r.text('key=sk-ant-api03-abcdefghijklmnop')).not.toContain('sk-ant-api03');
  });

  it('counts what it redacted so a spike is visible', () => {
    const r = new Redactor(policy.file.redaction.patterns);
    r.text('412-88-7301 and 509-22-6614');
    expect(r.redactionStats.hits['ssn']).toBeGreaterThan(0);
  });

  it('is idempotent', () => {
    const r = new Redactor(policy.file.redaction.patterns);
    const once = r.text('Tax ID 412-88-7301');
    expect(r.text(once)).toBe(once);
  });

  it('scrubs a registered secret that is stored as a NUMBER', () => {
    // Regression. An extracted balance is registered as the string it was
    // scraped from and stored as a coerced number, and `value()` originally
    // passed numbers through untouched — so a regulated figure survived in a
    // saved result document while every string form of it was scrubbed.
    const r = new Redactor(policy.file.redaction.patterns);
    r.registerSecret('55023.1');
    const out = r.value({ outputs: { savingsBalance: { value: 55023.1, sensitivity: 'pii' } } });
    expect(JSON.stringify(out)).not.toContain('55023.1');
  });

  it('leaves unrelated numbers alone', () => {
    const r = new Redactor(policy.file.redaction.patterns);
    r.registerSecret('55023.1');
    const out = r.value({ durationMs: 5220, steps: 6 });
    expect(out.durationMs).toBe(5220);
    expect(out.steps).toBe(6);
  });

  /**
   * The PAN rule recognises a format, and "13 to 19 digits" is also the shape
   * of a timestamp. Left ungated it redacted this system's own run ids, so
   * every persisted result named itself `replay-[REDACTED:PAN]-8e3d7a` and
   * could not be correlated to the run that produced it.
   *
   * Recall first, in every test below: the gate is only defensible if no real
   * card slips through it.
   */
  describe('card number detection', () => {
    const r = (): Redactor => new Redactor(policy.file.redaction.patterns);

    it.each([
      ['Visa', '4111111111111111'],
      ['Visa, spaced as printed', '4111 1111 1111 1111'],
      ['Visa, hyphenated', '4111-1111-1111-1111'],
      ['Visa 13-digit', '4222222222222'],
      ['Amex', '378282246310005'],
      ['Mastercard', '5555555555554444'],
      ['Mastercard 2-series', '2223003122003222'],
      ['Discover', '6011111111111117'],
      ['JCB', '3530111333300000'],
      ['Diners Club', '30569309025904'],
    ])('still redacts a real %s number', (_brand, pan) => {
      const out = r().text(`card on file ${pan} exp 04/29`);
      expect(out).not.toContain(pan);
      expect(out).toContain('[REDACTED:PAN]');
    });

    it.each([
      // The original defect: a run id, whose digits happen to satisfy Luhn.
      ['a run id', 'replay-20260905-015133-8e3d7a'],
      ['a bare timestamp', 'posted at 20260905015133'],
      ['a confirmation reference', 'confirmation CN480251 for 20260904161227'],
      ['a member and share id', 'member 100234 share 100234-S0001'],
      ['a content hash', 'contentHash cc19ae9132fdd8745e6bdd03f87a3773'],
    ])('does not redact %s', (_what, text) => {
      expect(r().text(text)).toBe(text);
    });

    it('rejects a number that passes Luhn but is from no issued range', () => {
      // 20260905015133 sums to 40 under Luhn — a clean pass. Nine numbers in
      // ten fail the check digit, which sounds decisive until the tenth is a
      // timestamp. The issuer range is what actually separates the two.
      expect(r().text('20260905015133')).toBe('20260905015133');
    });

    it('rejects a number in an issued range that fails the check digit', () => {
      // A Visa-shaped number with the last digit changed. Both gates are load
      // bearing; neither alone would keep this test and the one above passing.
      expect(r().text('4111111111111112')).toBe('4111111111111112');
    });

    it('refuses a policy that names a validator it does not have', () => {
      // Ignoring it would leave the rule matching exactly as much as before —
      // the safe direction for redaction, and the wrong one for trust, since
      // the policy would claim a checksum gate that was never applied.
      expect(
        () =>
          new Redactor([
            { name: 'pan', regex: '\\d+', replacement: 'x', validate: 'sha256' as 'card' },
          ]),
      ).toThrow(/unknown validator/i);
    });

    it('counts a hit only when a match was actually replaced', () => {
      const red = r();
      red.text('run 20260905015133 is not a card');
      expect(red.redactionStats.hits['pan']).toBeUndefined();
      red.text('but 4111111111111111 is');
      expect(red.redactionStats.hits['pan']).toBe(1);
    });
  });
});
