/**
 * Resolver tests.
 *
 * These cover the decisions that make replay safe rather than merely working:
 * that a weak match is refused, that an ambiguous match is refused, that a
 * tenant label overlay carries a descriptor to a differently-worded skin, and
 * that a recorded DOM id is not load-bearing.
 *
 * The ambiguity tests matter most. Anything can find an element when there is
 * exactly one candidate; the useful question is what happens when there are
 * two, and the answer has to be "stop", not "pick the first".
 */

import { describe, expect, it } from 'vitest';
import { MIN_MARGIN, MIN_SCORE, describeNode, matchStrength, resolve } from '../src/surface/web/resolver.js';
import type { ElementDescriptor } from '../src/types/artifact.js';
import type { UiNode } from '../src/types/surface.js';

function node(p: Partial<UiNode>): UiNode {
  return {
    handle: 'e1',
    role: 'textbox',
    name: '',
    label: '',
    labelSource: 'none',
    framePath: [],
    ordinal: 0,
    visible: true,
    enabled: true,
    hints: {},
    ...p,
  };
}

function desc(p: Partial<ElementDescriptor>): ElementDescriptor {
  return {
    description: 'test target',
    role: 'textbox',
    nameMatch: 'normalized',
    labelMatch: 'normalized',
    framePath: [],
    hints: {},
    ...p,
  };
}

describe('matchStrength', () => {
  it('is case- and whitespace-insensitive in normalized mode', () => {
    expect(matchStrength('Member ID', '  member   id  ', 'normalized')).toBe(1);
  });

  it('treats trailing label punctuation as identical, not merely similar', () => {
    // Legacy apps append colons and asterisks inconsistently between screens
    // and even between rows of the same form. Normalisation strips them, so
    // this is a full match rather than a degraded one — which matters: a
    // partial score would eat into the margin and could make a clear winner
    // look ambiguous.
    expect(matchStrength('Member ID', 'Member ID:', 'normalized')).toBe(1);
    expect(matchStrength('Member ID', 'Member ID *', 'normalized')).toBe(1);
  });

  it('gives partial credit for a close wording difference', () => {
    // Real tenant drift: one skin appends a noun to the label. Close enough to
    // still match, but scored below an exact match so an exact candidate on the
    // same screen always wins.
    const s = matchStrength('Opening Deposit', 'Opening Deposit Amount', 'normalized');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it('refuses a containment match that is too loose to be meaningful', () => {
    // The guard that stops short labels matching almost anything: "Member ID"
    // inside "Primary Member ID Number" shares too little of the string to be
    // evidence, so it scores zero rather than winning on a coincidence.
    expect(matchStrength('Member ID', 'Primary Member ID Number', 'normalized')).toBe(0);
  });

  it('refuses a match when the containment ratio is too low', () => {
    // "ID" appearing inside "Identification Document Number" is a coincidence,
    // not a match — accepting it would let short labels match almost anything.
    expect(matchStrength('ID', 'Identification Document Number', 'normalized')).toBe(0);
  });

  it('does not throw on a malformed regex descriptor', () => {
    expect(matchStrength('[unclosed', 'anything', 'regex')).toBe(0);
  });
});

describe('resolve', () => {
  it('finds a control whose only label came from an adjacent table cell', () => {
    const nodes = [
      node({ handle: 'e1', role: 'textbox', label: 'Member ID', labelSource: 'table-cell', container: 'Member Search' }),
      node({ handle: 'e2', role: 'textbox', label: 'Last Name', labelSource: 'table-cell', container: 'Member Search' }),
    ];
    const r = resolve(desc({ label: 'Member ID', container: 'Member Search' }), nodes);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.node.handle).toBe('e1');
      expect(r.score).toBeGreaterThanOrEqual(MIN_SCORE);
    }
  });

  it('refuses to choose between two identical candidates', () => {
    // Two "Amount" boxes with nothing to tell them apart. Clicking either is a
    // coin flip, and a coin flip inside a banking flow is the worst option.
    const nodes = [
      node({ handle: 'e1', label: 'Amount', container: 'Transfer' }),
      node({ handle: 'e2', label: 'Amount', container: 'Transfer' }),
    ];
    const r = resolve(desc({ label: 'Amount', container: 'Transfer' }), nodes);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('ambiguous');
      expect(r.candidates.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('disambiguates identical candidates using an ordinal', () => {
    const nodes = [
      node({ handle: 'e1', label: 'Amount', container: 'Transfer', ordinal: 0 }),
      node({ handle: 'e2', label: 'Amount', container: 'Transfer', ordinal: 1 }),
    ];
    const r = resolve(desc({ label: 'Amount', container: 'Transfer', ordinal: 1 }), nodes);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.handle).toBe('e2');
  });

  it('returns not_found rather than the least-bad option', () => {
    const nodes = [node({ handle: 'e1', role: 'button', name: 'Cancel' })];
    const r = resolve(desc({ role: 'textbox', label: 'Member ID' }), nodes);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  });

  it('ignores invisible and disabled controls', () => {
    const nodes = [
      node({ handle: 'e1', label: 'Member ID', visible: false }),
      node({ handle: 'e2', label: 'Member ID', enabled: false }),
    ];
    expect(resolve(desc({ label: 'Member ID' }), nodes).ok).toBe(false);
  });

  it('carries a descriptor to another tenant via a label overlay', () => {
    // The whole cross-tenant story in one test: an artifact recorded against
    // "Member ID" runs at an institution that calls the same field
    // "Member Number", with no re-recording and no artifact edit.
    const lakeshore = [
      node({ handle: 'e1', role: 'textbox', label: 'Member Number', container: 'Member Search' }),
      node({ handle: 'e2', role: 'textbox', label: 'Last Name', container: 'Member Search' }),
    ];
    const recorded = desc({ label: 'Member ID', container: 'Member Search' });

    expect(resolve(recorded, lakeshore).ok).toBe(false);

    const r = resolve(recorded, lakeshore, {
      labelOverrides: { 'Member ID': 'Member Number' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.handle).toBe('e1');
  });

  it('does not let a matching DOM id rescue an otherwise-wrong candidate', () => {
    // domId is weighted at ~2 on purpose. If it could carry a match, artifacts
    // would silently become tenant-specific again.
    const nodes = [
      node({ handle: 'e1', role: 'textbox', label: 'Completely Different', hints: { domId: 'ctl00$txtMbr' } }),
    ];
    const r = resolve(desc({ label: 'Member ID', hints: { domId: 'ctl00$txtMbr' } }), nodes);
    expect(r.ok).toBe(false);
  });

  it('reports which signals were missed, so drift is observable', () => {
    const nodes = [node({ handle: 'e1', role: 'textbox', label: 'Member ID', container: 'Renamed Panel' })];
    const r = resolve(desc({ label: 'Member ID', container: 'Member Search' }), nodes);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matchedSignals).toContain('label');
      expect(r.missedSignals).toContain('container');
    }
  });

  it('accepts a button recorded as a link when a skin swaps the element', () => {
    const nodes = [node({ handle: 'e1', role: 'link', name: 'Continue to Review' })];
    const r = resolve(desc({ role: 'button', name: 'Continue to Review' }), nodes);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.matchedSignals).toContain('role~compatible');
  });

  it('enforces the margin so a near-tie is never resolved', () => {
    const nodes = [
      node({ handle: 'e1', label: 'Account Nickname', container: 'New Account' }),
      node({ handle: 'e2', label: 'Account Nickname', container: 'New Accounts' }),
    ];
    const r = resolve(desc({ label: 'Account Nickname', container: 'New Account' }), nodes);
    if (r.ok) {
      expect(r.runnerUpScore === null || r.score - r.runnerUpScore >= MIN_MARGIN).toBe(true);
    } else {
      expect(r.reason).toBe('ambiguous');
    }
  });
});

describe('describeNode', () => {
  it('emits only semantic signals and never a matchable id', () => {
    const n = node({
      handle: 'e9',
      role: 'textbox',
      label: 'Member ID',
      container: 'Member Search',
      framePath: ['mainFrame'],
      hints: { domId: 'ctl00$MainContent$txtMbr', inputType: 'text' },
    });
    const d = describeNode(n, [n]);

    expect(d.label).toBe('Member ID');
    expect(d.container).toBe('Member Search');
    expect(d.framePath).toEqual(['mainFrame']);
    // The id is kept for forensics but must not appear as a matching field.
    expect(d.hints.domId).toBe('ctl00$MainContent$txtMbr');
    expect(d.name).toBeUndefined();
    expect(JSON.stringify({ ...d, hints: undefined })).not.toContain('ctl00');
  });

  it('only pins an ordinal when the semantic signals are genuinely not unique', () => {
    const a = node({ handle: 'e1', label: 'Amount', ordinal: 0 });
    const b = node({ handle: 'e2', label: 'Amount', ordinal: 1 });
    expect(describeNode(a, [a]).ordinal).toBeUndefined();
    expect(describeNode(b, [a, b]).ordinal).toBe(1);
  });
});
