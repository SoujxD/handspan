/**
 * Parameter references in conditions and extractions.
 *
 * The point of these is a two-phase commit. "Reached the review screen" and
 * "the review screen restates the amount this invocation was given" are
 * different assertions, and only the second makes review-then-post worth more
 * than clicking two buttons. Until conditions could reference a typed input
 * there was no way to write the second one.
 *
 * The live target cannot be made to produce a review/input mismatch - its
 * review screen echoes the form that was posted to it - so the mechanism is
 * proved here rather than in a demo.
 */

import { describe, expect, it } from 'vitest';
import { evaluateCondition, extract } from '../src/replay/evaluate.js';
import type { SurfaceSnapshot, UiNode } from '../src/types/surface.js';
import type { OutputField } from '../src/types/artifact.js';

function cell(over: Partial<UiNode>): UiNode {
  return {
    handle: 'e1',
    role: 'cell',
    name: '',
    label: '',
    labelSource: 'none',
    framePath: [],
    ordinal: 0,
    visible: true,
    enabled: true,
    hints: {},
    ...over,
  } as UiNode;
}

function screen(text: string, nodes: UiNode[] = []): SurfaceSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    url: 'https://example.test/transfer/review',
    title: 'CONFIRM FUNDS TRANSFER',
    nodes,
    text,
    frameUrls: ['https://example.test/transfer/review'],
  };
}

const REVIEW = screen('CONFIRM FUNDS TRANSFER From: 100234-S0001-12 To: 100234-S0001-13 Amount: $25.00');

describe('conditions can reference typed inputs', () => {
  it('passes when the screen restates the value this invocation was given', () => {
    const ok = evaluateCondition(
      { kind: 'textPresent', text: '{{amount}}', caseSensitive: false },
      { snapshot: REVIEW, resolveOptions: {}, params: { amount: '25.00' } },
    );
    expect(ok).toBe(true);
  });

  it('fails when the screen shows a DIFFERENT value than the caller passed', () => {
    // The case the checkpoint exists for: the form silently took something
    // other than what was typed, and the post step must not run.
    const ok = evaluateCondition(
      { kind: 'textPresent', text: '{{amount}}', caseSensitive: false },
      { snapshot: REVIEW, resolveOptions: {}, params: { amount: '2500.00' } },
    );
    expect(ok).toBe(false);
  });

  it('leaves an unknown reference literal so it fails loudly rather than matching everything', () => {
    // An empty substitution would make `textPresent ""` true on every screen -
    // an assertion that silently always passes is worse than none.
    const ok = evaluateCondition(
      { kind: 'textPresent', text: '{{amont}}', caseSensitive: false },
      { snapshot: REVIEW, resolveOptions: {}, params: { amount: '25.00' } },
    );
    expect(ok).toBe(false);
  });

  it('substitutes in regex and url conditions too', () => {
    expect(
      evaluateCondition(
        { kind: 'regexPresent', pattern: 'Amount: \\$\\s*{{amount}}' },
        { snapshot: REVIEW, resolveOptions: {}, params: { amount: '25\\.00' } },
      ),
    ).toBe(true);

    expect(
      evaluateCondition(
        { kind: 'urlMatches', pattern: '/{{leg}}$' },
        { snapshot: REVIEW, resolveOptions: {}, params: { leg: 'review' } },
      ),
    ).toBe(true);
  });

  it('is inert when no params are supplied, so old artifacts behave unchanged', () => {
    expect(
      evaluateCondition(
        { kind: 'textPresent', text: 'CONFIRM FUNDS TRANSFER', caseSensitive: false },
        { snapshot: REVIEW, resolveOptions: {} },
      ),
    ).toBe(true);
  });
});

describe('extraction can address the row the caller named', () => {
  const grid = [
    cell({ rowKey: '100234-S0001-12', columnHeader: 'Share ID', value: '100234-S0001-12' }),
    cell({ rowKey: '100234-S0001-12', columnHeader: 'Balance', value: '$45.00' }),
    cell({ rowKey: '100234-S0001-13', columnHeader: 'Share ID', value: '100234-S0001-13' }),
    cell({ rowKey: '100234-S0001-13', columnHeader: 'Balance', value: '$14.00' }),
  ];

  const field = (rowMatch: string): OutputField =>
    ({
      name: 'shareBalance',
      type: 'money',
      description: 'balance',
      sensitivity: 'pii',
      required: true,
      transform: 'stripCurrency',
      extraction: {
        via: 'fromTableCell',
        rowMatch,
        columnLabel: 'Balance',
        matchMode: 'contains',
        framePath: [],
      },
    }) as OutputField;

  it('reads the row named by the input, not the one present at record time', () => {
    const snap = screen('', grid);
    const a = extract(field('{{shareId}}'), {
      snapshot: snap,
      resolveOptions: {},
      params: { shareId: '100234-S0001-13' },
    });
    expect(a.ok).toBe(true);
    expect(a.value).toBe(14);
  });

  it('a literal rowMatch returns the recorded row for every caller - the bug this replaced', () => {
    // Kept as a test because the failure mode is silent: a frozen rowMatch does
    // not error, it answers about the wrong member.
    const snap = screen('', grid);
    const a = extract(field('100234-S0001-12'), {
      snapshot: snap,
      resolveOptions: {},
      params: { shareId: '100234-S0001-13' },
    });
    expect(a.value).toBe(45);
  });
});
