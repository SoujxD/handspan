/**
 * A hand-written capability, used as a TEST FIXTURE only.
 *
 * This is NOT a discovered artifact and is not shipped in /artifacts. It exists
 * so the replay engine — guards, outcome classification, resolution, extraction,
 * checkpoints, the whole error taxonomy — can be exercised against the live
 * application without spending a model call, and so a regression in the engine
 * is caught by `npm test` rather than by a discovery run failing mysteriously.
 *
 * It is written the way the compiler would write one: semantic descriptors,
 * no element ids in matching position, a checkpoint on every state change, and
 * the unhappy paths declared up front.
 */

import { SCHEMA_VERSION, type Capability } from '../../src/types/artifact.js';

export function referenceCapability(baseUrl: string, tenantId = 'northstar'): Capability {
  const inMainFrame = ['mainFrame'];

  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'ref_member_savings_balance',
    version: 1,
    name: 'Read member savings balance (test fixture)',
    description:
      'Signs in to the servicing console, looks up a member by id, and returns the current balance ' +
      'of their SAVINGS account. Returns a business outcome if the member does not exist or the ' +
      'record is access-restricted.',

    surface: {
      kind: 'legacy_web',
      product: 'meridian-core',
      productVersion: '8.4',
      recordedOnTenant: tenantId,
      entryUrl: '{{baseUrl}}/login',
    },

    inputs: [
      {
        name: 'memberId',
        type: 'string',
        description: 'The member number to look up.',
        required: true,
        sensitivity: 'internal',
        example: '12345',
      },
      {
        name: 'username',
        type: 'string',
        description: 'Servicing console user id.',
        required: true,
        sensitivity: 'internal',
        example: 'teller01',
      },
      {
        name: 'password',
        type: 'string',
        description: 'Servicing console password. Never logged or persisted.',
        required: true,
        sensitivity: 'secret',
      },
    ],

    outputs: [
      {
        name: 'savingsBalance',
        type: 'money',
        description: 'Current balance of the member\'s SAVINGS account.',
        sensitivity: 'internal',
        // Two-axis grid read: a column-header lookup alone would return
        // whichever row came first, which is wrong for any member who also
        // holds a checking account.
        extraction: {
          via: 'fromTableCell',
          rowMatch: 'SAVINGS',
          columnLabel: 'Current Balance',
          matchMode: 'contains',
          framePath: inMainFrame,
        },
        transform: 'stripCurrency',
        required: true,
      },
      {
        name: 'memberName',
        type: 'string',
        description: 'Member name as shown on the record.',
        sensitivity: 'pii',
        extraction: {
          via: 'fromLabelledCell',
          label: 'Member Name',
          labelMatch: 'normalized',
          framePath: inMainFrame,
          direction: 'right',
        },
        transform: 'trim',
        required: true,
      },
    ],

    steps: [
      {
        id: 's01',
        intent: 'Enter the servicing console user id.',
        act: {
          action: 'type',
          target: {
            description: 'textbox labelled "User ID" on the sign-in form',
            role: 'textbox',
            label: 'User ID',
            nameMatch: 'normalized',
            labelMatch: 'normalized',
            framePath: [],
            hints: { inputType: 'text' },
          },
          value: { from: 'param', name: 'username' },
          clearFirst: true,
        },
        risk: 'safe',
        retry: { attempts: 2, backoffMs: 500 },
      },
      {
        id: 's02',
        intent: 'Enter the servicing console password.',
        act: {
          action: 'type',
          target: {
            // No <label for> on this field; its only label is the adjacent
            // table cell. This step is the one that proves the derivation
            // ladder is load-bearing rather than decorative.
            description: 'textbox labelled "Password" on the sign-in form',
            role: 'textbox',
            label: 'Password',
            nameMatch: 'normalized',
            labelMatch: 'normalized',
            framePath: [],
            hints: { inputType: 'password' },
          },
          value: { from: 'secret', ref: 'password' },
          clearFirst: true,
        },
        risk: 'sensitive',
        retry: { attempts: 1, backoffMs: 750 },
      },
      {
        id: 's03',
        intent: 'Sign in to the servicing console.',
        act: {
          action: 'click',
          target: {
            description: 'button "Sign In"',
            role: 'button',
            name: 'Sign In',
            nameMatch: 'normalized',
            labelMatch: 'normalized',
            framePath: [],
            hints: {},
          },
        },
        risk: 'safe',
        checkpoint: { kind: 'urlMatches', pattern: '/(shell|home|notice)' },
        retry: { attempts: 1, backoffMs: 750 },
      },
      {
        id: 's04',
        intent: 'Open the member search screen.',
        act: { action: 'navigate', url: '{{baseUrl}}/member/search' },
        risk: 'safe',
        checkpoint: { kind: 'textPresent', text: 'Member Search', caseSensitive: false },
        retry: { attempts: 1, backoffMs: 750 },
      },
      {
        id: 's05',
        intent: 'Enter the member number to look up.',
        act: {
          action: 'type',
          target: {
            description: 'textbox labelled "Member ID" in the "Member Search" panel',
            role: 'textbox',
            label: 'Member ID',
            container: 'Member Search',
            nameMatch: 'normalized',
            labelMatch: 'normalized',
            framePath: inMainFrame,
            hints: { inputType: 'text' },
          },
          value: { from: 'param', name: 'memberId' },
          clearFirst: true,
        },
        risk: 'safe',
        retry: { attempts: 2, backoffMs: 500 },
      },
      {
        id: 's06',
        intent: 'Run the member search.',
        act: {
          action: 'click',
          target: {
            description: 'button "Search" in the "Member Search" panel',
            role: 'button',
            name: 'Search',
            container: 'Member Search',
            nameMatch: 'normalized',
            labelMatch: 'normalized',
            framePath: inMainFrame,
            hints: {},
          },
        },
        risk: 'safe',
        // Broad on purpose — the search legitimately lands on the member
        // record, a not-found page, or a permission denial, and a narrow
        // checkpoint would mislabel a valid business answer as a failure.
        // Each branch is nonetheless keyed to text that appears ONLY on its
        // destination screen.
        //
        // Note what is deliberately NOT used here: a URL pattern like
        // `/member/[^/]+$`. It looks specific and is not — it also matches
        // `/member/search`, so the checkpoint passes while still sitting on
        // the search form, and the failure only surfaces later as a confusing
        // final-checkpoint miss. A checkpoint has to be false everywhere
        // earlier in the flow, not merely true at the end.
        checkpoint: {
          kind: 'any',
          of: [
            { kind: 'textPresent', text: 'Share Accounts', caseSensitive: false },
            { kind: 'textPresent', text: 'No member record found', caseSensitive: false },
            { kind: 'textPresent', text: 'Authorization required', caseSensitive: false },
          ],
        },
        retry: { attempts: 1, backoffMs: 750 },
      },
    ],

    successCheckpoint: {
      kind: 'all',
      of: [
        { kind: 'textPresent', text: 'Share Accounts', caseSensitive: false },
        { kind: 'textPresent', text: 'Current Balance', caseSensitive: false },
      ],
    },

    outcomes: [
      {
        code: 'member_not_found',
        title: 'No member record exists for that number',
        classification: 'business',
        detect: { kind: 'textPresent', text: 'No member record found', caseSensitive: false },
        scope: 'global',
        extract: [],
      },
      {
        code: 'member_access_restricted',
        title: 'Member record is flagged RESTRICTED and this role may not view it',
        classification: 'business',
        detect: { kind: 'textPresent', text: 'Authorization required', caseSensitive: false },
        scope: 'global',
        extract: [],
      },
      {
        code: 'workstation_advisory',
        title: 'Interstitial system advisory',
        classification: 'recoverable',
        detect: { kind: 'textPresent', text: 'Session advisory', caseSensitive: false },
        scope: 'global',
        recovery: {
          do: 'click',
          target: {
            description: 'button "Continue" dismissing the advisory',
            role: 'button',
            name: 'Continue',
            nameMatch: 'normalized',
            labelMatch: 'normalized',
            framePath: [],
            hints: {},
          },
        },
        extract: [],
      },
      {
        code: 'session_expired',
        title: 'The servicing session timed out',
        classification: 'escalate',
        detect: { kind: 'textPresent', text: 'Your session has timed out', caseSensitive: false },
        scope: 'global',
        operatorGuidance:
          'Sign back in to the servicing console in the live session, return to the member search screen, then hand control back.',
        extract: [],
      },
      {
        code: 'application_error',
        title: 'The core application returned a server error',
        classification: 'hard',
        detect: { kind: 'textPresent', text: 'Server Error', caseSensitive: false },
        scope: 'global',
        extract: [],
      },
    ],

    tenants: [
      {
        tenantId,
        displayName: 'Northstar Community Credit Union',
        baseUrl,
        productVersion: '8.4',
        labelOverrides: {},
        additionalOutcomes: [],
        overrides: {},
        verification: { lastResult: 'unverified' },
      },
    ],

    policy: {
      maxRisk: 'sensitive',
      requiresConfirmation: false,
      allowedOrigins: [],
    },

    governance: {
      approval: 'approved',
      stability: { runs: 0, successes: 0 },
      reviewedBy: 'test fixture',
    },

    provenance: {
      discoveredAt: '2026-01-01T00:00:00.000Z',
      model: 'hand-written test fixture',
      discoveryRunId: 'fixture',
      generator: 'handspan',
    },
  };
}

/**
 * The same capability bound to the variant institution.
 *
 * The delta between two institutions running the same vendor product is a
 * label overlay plus the one guard that tenant needs — not a re-recording.
 */
export function lakeshoreBinding(baseUrl: string): Capability['tenants'][number] {
  return {
    tenantId: 'lakeshore',
    displayName: 'Lakeshore Federal Credit Union',
    baseUrl,
    productVersion: '8.6',
    labelOverrides: {
      'Member ID': 'Member Number',
      Search: 'Find Member',
    },
    additionalOutcomes: [
      {
        code: 'daily_notice',
        title: 'Lakeshore daily maintenance notice',
        classification: 'recoverable',
        detect: { kind: 'textPresent', text: 'Scheduled maintenance window', caseSensitive: false },
        scope: 'global',
        recovery: {
          do: 'click',
          target: {
            description: 'button "Acknowledge" dismissing the daily notice',
            role: 'button',
            name: 'Acknowledge',
            nameMatch: 'normalized',
            labelMatch: 'normalized',
            framePath: [],
            hints: {},
          },
        },
        extract: [],
      },
    ],
    overrides: {},
    verification: { lastResult: 'unverified' },
  };
}
