/**
 * Condition evaluation and output extraction.
 *
 * Both operate on the same normalized snapshot the discovery model saw, which
 * is the property that makes a checkpoint mean the same thing at record time
 * and replay time. If conditions were evaluated against raw HTML while the
 * model reasoned about an abstracted view, a checkpoint would be an assertion
 * about a thing nobody had actually looked at.
 *
 * Everything here is pure: (condition, snapshot) -> boolean. No I/O, no
 * clock, no model. That is what makes the replay path reproducible and what
 * makes these the easiest parts of the system to unit-test.
 */

import type { Condition, Extraction, NameMatch, OutputField } from '../types/artifact.js';
import type { SurfaceSnapshot, UiNode } from '../types/surface.js';
import { normalizeText } from '../types/surface.js';
import { matchStrength, resolve, type ResolveOptions } from '../surface/web/resolver.js';

export interface EvalContext {
  snapshot: SurfaceSnapshot;
  resolveOptions: ResolveOptions;
}

export function evaluateCondition(cond: Condition, ctx: EvalContext): boolean {
  const { snapshot } = ctx;

  switch (cond.kind) {
    case 'urlMatches':
      return safeRegex(cond.pattern)?.test(snapshot.url) ?? false;

    case 'textPresent':
      return cond.caseSensitive
        ? snapshot.text.includes(cond.text)
        : normalizeText(snapshot.text).includes(normalizeText(cond.text));

    case 'textAbsent':
      return !(cond.caseSensitive
        ? snapshot.text.includes(cond.text)
        : normalizeText(snapshot.text).includes(normalizeText(cond.text)));

    case 'regexPresent':
      return safeRegex(cond.pattern)?.test(snapshot.text) ?? false;

    case 'elementPresent':
      return resolve(cond.target, snapshot.nodes, ctx.resolveOptions).ok;

    case 'elementAbsent':
      return !resolve(cond.target, snapshot.nodes, ctx.resolveOptions).ok;

    case 'httpStatusAtLeast':
      return (snapshot.lastStatus ?? 0) >= cond.status;

    case 'all':
      return cond.of.every((c) => evaluateCondition(c, ctx));

    case 'any':
      return cond.of.some((c) => evaluateCondition(c, ctx));

    case 'not':
      return !evaluateCondition(cond.of, ctx);
  }
}

/** Human-readable rendering, for the `expected` field of a failure report. */
export function describeCondition(cond: Condition): string {
  switch (cond.kind) {
    case 'urlMatches':
      return `URL matching /${cond.pattern}/`;
    case 'textPresent':
      return `text "${cond.text}" present on screen`;
    case 'textAbsent':
      return `text "${cond.text}" absent from screen`;
    case 'regexPresent':
      return `page text matching /${cond.pattern}/`;
    case 'elementPresent':
      return `element present: ${cond.target.description}`;
    case 'elementAbsent':
      return `element absent: ${cond.target.description}`;
    case 'httpStatusAtLeast':
      return `HTTP status >= ${cond.status}`;
    case 'all':
      return cond.of.map(describeCondition).join(' AND ');
    case 'any':
      return cond.of.map(describeCondition).join(' OR ');
    case 'not':
      return `NOT (${describeCondition(cond.of)})`;
  }
}

/**
 * For a failed checkpoint, say which *part* failed.
 *
 * "checkpoint failed" is not debuggable; "URL matched but the expected text was
 * missing" points straight at the problem. Worth the extra traversal.
 */
export function explainFailure(cond: Condition, ctx: EvalContext): string {
  if (cond.kind === 'all') {
    const failed = cond.of.filter((c) => !evaluateCondition(c, ctx));
    return failed.map(describeCondition).join('; ') || 'all sub-conditions passed';
  }
  return describeCondition(cond);
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface ExtractResult {
  ok: boolean;
  raw?: string;
  value?: string | number | boolean | null;
  problem?: string;
}

export function extract(field: OutputField, ctx: EvalContext): ExtractResult {
  const raw = readRaw(field.extraction, ctx);
  if (raw === undefined) {
    return { ok: false, problem: describeExtraction(field.extraction) };
  }

  const transformed = applyTransform(raw, field.transform);
  const typed = coerce(transformed, field.type);
  if (typed === undefined) {
    return { ok: false, raw, problem: `value "${transformed}" is not a valid ${field.type}` };
  }
  return { ok: true, raw, value: typed };
}

function readRaw(ex: Extraction, ctx: EvalContext): string | undefined {
  const { snapshot } = ctx;

  switch (ex.via) {
    case 'elementText':
    case 'elementValue': {
      const r = resolve(ex.target, snapshot.nodes, ctx.resolveOptions);
      if (!r.ok) return undefined;
      return ex.via === 'elementValue' ? (r.node.value ?? '') : (r.node.value || r.node.label || r.node.name);
    }

    case 'fromLabelledCell': {
      // The perception layer already derived each cell's label from its
      // structural neighbour, so this is a lookup rather than a DOM walk.
      const candidates = snapshot.nodes.filter(
        (n) => n.role === 'cell' && matchStrength(ex.label, n.label, ex.labelMatch) > 0,
      );
      const hit = candidates.find((n) => (n.value ?? '').trim().length > 0);
      return hit?.value;
    }

    case 'fromTableCell': {
      // Two-axis lookup. Both must agree, which is what stops "Current Balance"
      // from silently returning whichever row happens to come first.
      const rows = groupByRow(snapshot.nodes);
      for (const cells of rows.values()) {
        const rowMatches = cells.some(
          (c) => matchStrength(ex.rowMatch, c.value ?? '', ex.matchMode) > 0,
        );
        if (!rowMatches) continue;
        const cell = cells.find(
          (c) => matchStrength(ex.columnLabel, c.columnHeader ?? c.label, 'normalized') > 0,
        );
        if (cell?.value) return cell.value;
      }
      return undefined;
    }

    case 'regexOnPageText': {
      const re = safeRegex(ex.pattern);
      const m = re?.exec(snapshot.text);
      return m?.[ex.group] ?? m?.[0];
    }

    case 'urlCapture': {
      const re = safeRegex(ex.pattern);
      const m = re?.exec(snapshot.url);
      return m?.[ex.group] ?? m?.[0];
    }
  }
}

function groupByRow(nodes: UiNode[]): Map<string, UiNode[]> {
  const rows = new Map<string, UiNode[]>();
  for (const n of nodes) {
    if (n.role !== 'cell') continue;
    // rowKey is the row's first-cell text; grouping on it plus the container
    // keeps two grids on the same screen from bleeding into each other.
    const key = `${n.framePath.join('/')}|${n.container ?? ''}|${n.rowKey ?? ''}`;
    const list = rows.get(key);
    if (list) list.push(n);
    else rows.set(key, [n]);
  }
  return rows;
}

export function describeExtraction(ex: Extraction): string {
  switch (ex.via) {
    case 'elementText':
    case 'elementValue':
      return `element ${ex.target.description}`;
    case 'fromLabelledCell':
      return `cell labelled "${ex.label}"`;
    case 'fromTableCell':
      return `cell at row "${ex.rowMatch}" / column "${ex.columnLabel}"`;
    case 'regexOnPageText':
      return `page text matching /${ex.pattern}/`;
    case 'urlCapture':
      return `URL matching /${ex.pattern}/`;
  }
}

function applyTransform(v: string, t: OutputField['transform']): string {
  switch (t) {
    case 'none':
      return v;
    case 'trim':
      return v.trim();
    case 'stripCurrency':
      return v.replace(/[^0-9.\-]/g, '');
    case 'digitsOnly':
      return v.replace(/\D/g, '');
  }
}

function coerce(v: string, type: OutputField['type']): string | number | boolean | null | undefined {
  switch (type) {
    case 'string':
    case 'enum':
      return v;
    case 'boolean':
      if (/^(true|yes|y|1)$/i.test(v)) return true;
      if (/^(false|no|n|0)$/i.test(v)) return false;
      return undefined;
    case 'number':
    case 'money': {
      const n = Number(v.replace(/[,$£€\s]/g, ''));
      return Number.isFinite(n) ? n : undefined;
    }
  }
}

/**
 * A malformed pattern in an artifact must not crash the run — it should fail
 * the condition and be reported as such, so a bad recording surfaces as a
 * debuggable checkpoint failure instead of a stack trace.
 */
function safeRegex(pattern: string, flags = 'i'): RegExp | undefined {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return undefined;
  }
}

export function matchMode(m: NameMatch | undefined): NameMatch {
  return m ?? 'normalized';
}
