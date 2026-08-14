/**
 * The tool surface exposed to the discovery model.
 *
 * Design rule: the model may only refer to elements by the opaque handles it
 * was just shown. There is no `css_selector` parameter and no `xpath`
 * parameter, deliberately — if the model could emit a selector, the recorded
 * artifact would inherit it, and the whole portability argument collapses.
 * Constraining the tool surface is what constrains the artifact.
 *
 * `finish` carries the model's *contract proposal* — inputs, outputs,
 * checkpoint, business outcomes — rather than just "done". Asking for the
 * contract explicitly is what turns a transcript into a capability: the model
 * is the only participant that knows the "no such member" screen exists,
 * because it is the only one that read the app.
 */

import type Anthropic from '@anthropic-ai/sdk';

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'observe',
    description:
      'Re-read the current screen. Returns the normalized element list with fresh handles and the visible text. ' +
      'Handles from previous observations become invalid, so call this after anything that changes the page. ' +
      'You are given a fresh observation automatically after every action, so you rarely need to call this directly.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why you need to re-read the screen.' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'navigate',
    description:
      'Go to an absolute URL. Subject to the navigation allowlist — a denied URL returns an error explaining why, ' +
      'and you should not retry it or look for a way around it.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL.' },
        intent: { type: 'string', description: 'One sentence: why this navigation, in business terms.' },
        exploratory: {
          type: 'boolean',
          description:
            'Set true when this action is a SIDE TRIP to observe an alternative outcome screen rather than ' +
            'part of the task. Exploratory actions still run, and what you see still informs your detectors, ' +
            'but they are excluded from the recorded flow. Use this for probes such as searching an id that ' +
            'will not exist, and return to where you were afterwards.',
        },
      },
      required: ['url', 'intent'],
    },
  },
  {
    name: 'click',
    description: 'Click an element by its handle from the most recent observation.',
    input_schema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'Handle such as "e12" from the current observation.' },
        intent: { type: 'string', description: 'One sentence: what this click is meant to accomplish.' },
        exploratory: {
          type: 'boolean',
          description:
            'Set true when this action is a SIDE TRIP to observe an alternative outcome screen rather than ' +
            'part of the task. Exploratory actions still run, and what you see still informs your detectors, ' +
            'but they are excluded from the recorded flow. Use this for probes such as searching an id that ' +
            'will not exist, and return to where you were afterwards.',
        },
      },
      required: ['handle', 'intent'],
    },
  },
  {
    name: 'type_text',
    description:
      'Type into a text field by handle. If the value is one the caller should supply per invocation ' +
      '(a member id, an amount, a nickname), set `parameter` to the name you will declare in `finish.inputs`. ' +
      'The recorded step then stores a parameter reference rather than this literal value, which is what makes ' +
      'the capability reusable — and is required for anything sensitive.',
    input_schema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        text: { type: 'string', description: 'The value to type right now, for this discovery run.' },
        parameter: {
          type: 'string',
          description: 'Optional. Input parameter name this value should be bound to, e.g. "memberId".',
        },
        intent: { type: 'string' },
        exploratory: {
          type: 'boolean',
          description:
            'Set true when this action is a SIDE TRIP to observe an alternative outcome screen rather than ' +
            'part of the task. Exploratory actions still run, and what you see still informs your detectors, ' +
            'but they are excluded from the recorded flow. Use this for probes such as searching an id that ' +
            'will not exist, and return to where you were afterwards.',
        },
      },
      required: ['handle', 'text', 'intent'],
    },
  },
  {
    name: 'select_option',
    description: 'Choose an option in a dropdown by handle, using the option text a human would see.',
    input_schema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        value: { type: 'string', description: 'Visible option text.' },
        parameter: { type: 'string', description: 'Optional input parameter name to bind this to.' },
        intent: { type: 'string' },
        exploratory: {
          type: 'boolean',
          description:
            'Set true when this action is a SIDE TRIP to observe an alternative outcome screen rather than ' +
            'part of the task. Exploratory actions still run, and what you see still informs your detectors, ' +
            'but they are excluded from the recorded flow. Use this for probes such as searching an id that ' +
            'will not exist, and return to where you were afterwards.',
        },
      },
      required: ['handle', 'value', 'intent'],
    },
  },
  {
    name: 'record_note',
    description:
      'Record something you learned that is not an action — an error state you saw, a validation rule, ' +
      'a screen that only appears sometimes. These become candidate business outcomes and recovery rules. ' +
      'Use this whenever the app tells you something a future caller would need to know.',
    input_schema: {
      type: 'object',
      properties: {
        note: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['business_outcome', 'recoverable_condition', 'validation_rule', 'observation'],
        },
      },
      required: ['note', 'kind'],
    },
  },
  {
    name: 'escalate',
    description:
      'Hand this session to a human operator. Use it when you are genuinely stuck, when the only way forward ' +
      'is an action policy refuses, or when proceeding would risk an irreversible change you are not certain about. ' +
      'Escalating is a legitimate outcome, not a failure — a wrong click in a banking system is far worse than a pause.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why you cannot safely continue.' },
        guidance: { type: 'string', description: 'What you want the human to do.' },
      },
      required: ['reason', 'guidance'],
    },
  },
  {
    name: 'finish',
    description:
      'Declare the goal complete and hand back the capability contract. Everything you pass here becomes the ' +
      'reusable artifact, so it must describe the *general* capability, not this one run.',
    input_schema: {
      type: 'object',
      properties: {
        capabilityId: {
          type: 'string',
          description: 'Stable snake_case id, e.g. "member_savings_balance". Lowercase, digits, underscore, dot.',
        },
        name: { type: 'string', description: 'Short human title.' },
        description: {
          type: 'string',
          description:
            'What a calling agent needs to decide whether to invoke this. State what it does and what it returns.',
        },
        inputs: {
          type: 'array',
          description: 'Parameters the caller supplies per invocation. Must cover every `parameter` you bound.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['string', 'number', 'boolean', 'money', 'enum'] },
              description: { type: 'string' },
              required: { type: 'boolean' },
              sensitivity: {
                type: 'string',
                enum: ['public', 'internal', 'pii', 'secret'],
                description:
                  'Classify honestly. `pii` and `secret` values are never written to artifacts or logs, ' +
                  'and `secret` values are never shown to a model.',
              },
              example: { type: 'string' },
              enumValues: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'type', 'description'],
          },
        },
        outputs: {
          type: 'array',
          description:
            'Values to extract and return. On form-style screens use `fromLabelledCell`. To read a value out of ' +
            'a data grid you must use `fromTableCell` and give both the row and the column — a column header alone ' +
            'matches every row, and the neighbouring cell in a grid is a different column, not a label.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['string', 'number', 'boolean', 'money', 'enum'] },
              description: { type: 'string' },
              sensitivity: { type: 'string', enum: ['public', 'internal', 'pii', 'secret'] },
              extractionKind: {
                type: 'string',
                enum: ['fromLabelledCell', 'fromTableCell', 'regexOnPageText', 'urlCapture', 'elementText'],
                description:
                  'fromLabelledCell for form-style screens (label cell, value cell beside it). ' +
                  'fromTableCell for data grids, where you need BOTH a row and a column to identify a value.',
              },
              label: {
                type: 'string',
                description: 'For fromLabelledCell: the visible label text whose neighbouring cell holds the value.',
              },
              rowMatch: {
                type: 'string',
                description:
                  'For fromTableCell: text identifying the row, e.g. "SAVINGS". Matched against the row cells.',
              },
              columnLabel: {
                type: 'string',
                description: 'For fromTableCell: the column header text, e.g. "Current Balance".',
              },
              direction: { type: 'string', enum: ['right', 'below'] },
              pattern: { type: 'string', description: 'For regexOnPageText / urlCapture. Use a capture group.' },
              handle: { type: 'string', description: 'For elementText: a handle from the current observation.' },
              transform: { type: 'string', enum: ['none', 'trim', 'stripCurrency', 'digitsOnly'] },
            },
            required: ['name', 'type', 'description', 'extractionKind'],
          },
        },
        successCheckpoint: {
          type: 'object',
          description:
            'How replay proves it reached the goal state. Pick something specific to the end screen — ' +
            'a URL pattern or text that appears there and nowhere earlier in the flow.',
          properties: {
            kind: { type: 'string', enum: ['urlMatches', 'textPresent', 'regexPresent'] },
            value: { type: 'string' },
          },
          required: ['kind', 'value'],
        },
        businessOutcomes: {
          type: 'array',
          description:
            'States that are legitimate answers rather than failures ("no such member", "permission denied"), ' +
            'and states the engine can recover from on its own (a dismissable interstitial). Include everything ' +
            'you saw or inferred — this is the part a happy-path recording always misses.',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'snake_case machine name the caller switches on.' },
              title: { type: 'string' },
              classification: {
                type: 'string',
                enum: ['business', 'recoverable', 'hard', 'escalate'],
                description:
                  'business = a valid answer; recoverable = the engine can fix it and continue; ' +
                  'hard = stop with an error; escalate = needs a person.',
              },
              detectKind: { type: 'string', enum: ['textPresent', 'regexPresent', 'urlMatches'] },
              detectValue: {
                type: 'string',
                description:
                  'For regexPresent/urlMatches this is a JavaScript regular expression. Do NOT write inline ' +
                  'flag groups such as (?i) or (?s) — ECMAScript does not support them and the pattern will ' +
                  'fail to compile. Matching is already case-insensitive and dot-matches-newline. ' +
                  'Prefer textPresent unless you genuinely need alternation.',
              },
              recoveryClickLabel: {
                type: 'string',
                description: 'For `recoverable`: the visible label of the button that dismisses it.',
              },
              operatorGuidance: { type: 'string', description: 'For `escalate`: what the human should do.' },
            },
            required: ['code', 'title', 'classification', 'detectKind', 'detectValue'],
          },
        },
      },
      required: ['capabilityId', 'name', 'description', 'successCheckpoint'],
    },
  },
];
