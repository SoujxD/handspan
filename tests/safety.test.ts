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
});
