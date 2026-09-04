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
  /**
   * Typed inputs for this run, so an extraction can address a row the CALLER
   * named rather than one fixed at record time.
   *
   * Reading "the Balance of share 100234-S0070" is the ordinary case for any
   * data grid: which row you want is an argument, not a constant. Without
   * this, `rowMatch` could only ever hold a literal, so a recording made
   * against one row would silently look for that same row forever - and the
   * discovery model, correctly, wrote `{{shareId}}` and had it not resolve.
   *
   * Same `{{name}}` syntax the artifact already uses for `{{baseUrl}}`.
   */
  params?: Record<string, string>;
}

/** Substitute `{{param}}` references. Unknown names are left alone so they
 *  surface in the failure message rather than becoming an empty match that
 *  silently returns the first row of the table. */
function fill(text: string, params: Record<string, string> | undefined): string {
  if (!params || !text.includes('{{')) return text;
  return text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (whole, name: string) =>
    params[name] !== undefined ? params[name] : whole,
  );
}

export function evaluateCondition(cond: Condition, ctx: EvalContext): boolean {
  const { snapshot } = ctx;

  switch (cond.kind) {
    case 'urlMatches':
      return safeRegex(fill(cond.pattern, ctx.params))?.test(snapshot.url) ?? false;

    case 'textPresent': {
      const want = fill(cond.text, ctx.params);
      return cond.caseSensitive
        ? snapshot.text.includes(want)
        : normalizeText(snapshot.text).includes(normalizeText(want));
    }

    case 'textAbsent': {
      const want = fill(cond.text, ctx.params);
      return !(cond.caseSensitive
        ? snapshot.text.includes(want)
        : normalizeText(snapshot.text).includes(normalizeText(want)));
    }

    case 'regexPresent':
      return safeRegex(fill(cond.pattern, ctx.params))?.test(snapshot.text) ?? false;

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
      const wantLabel = fill(ex.label, ctx.params);
      const byLabel = snapshot.nodes.filter(
        (n) => n.role === 'cell' && matchStrength(wantLabel, n.label, ex.labelMatch) > 0,
      );
      const hit = byLabel.find((n) => (n.value ?? '').trim().length > 0);
      if (hit?.value) return hit.value;

      /**
       * Fallback: match the ROW key instead of the cell label.
       *
       * Confirmation and summary screens are routinely built as a two-column
       * `Field | Value` table — which has a header row, so the perception layer
       * correctly treats it as a data grid and labels the value cell with its
       * column header ("Value") rather than with the field name. The label
       * lookup then misses, even though a human reads the screen exactly the
       * way the extraction rule is written.
       *
       * Matching on `rowKey` recovers it: the row whose first cell says
       * "Confirmation Number" holds the confirmation number. This is a
       * key/value table wearing a grid's clothes, and both readings have to
       * work for the rule to mean what its author intended.
       */
      const byRow = snapshot.nodes.filter(
        (n) =>
          n.role === 'cell' &&
          n.rowKey !== undefined &&
          matchStrength(ex.label, n.rowKey, ex.labelMatch) > 0 &&
          (n.value ?? '').trim().length > 0 &&
          // Skip the key cell itself; we want its neighbour's value.
          normalizeText(n.value) !== normalizeText(n.rowKey),
      );
      return byRow[0]?.value;
    }

    case 'fromTableCell': {
      // Two-axis lookup. Both must agree, which is what stops "Current Balance"
      // from silently returning whichever row happens to come first.
      const wantRow = fill(ex.rowMatch, ctx.params);
      const wantColumn = fill(ex.columnLabel, ctx.params);
      const rows = groupByRow(snapshot.nodes);
      for (const cells of rows.values()) {
        const rowMatches = cells.some(
          (c) => matchStrength(wantRow, c.value ?? '', ex.matchMode) > 0,
        );
        if (!rowMatches) continue;
        const cell = cells.find(
          (c) => matchStrength(wantColumn, c.columnHeader ?? c.label, 'normalized') > 0,
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
 * Compile a pattern from an artifact.
 *
 * Flags are `i` and `s` by design. Case-insensitivity is what anyone writing a
 * page-text matcher expects, and `s` (dot matches newline) matters because the
 * page text this runs against is multi-line — a pattern like `Account.*SAVINGS`
 * would otherwise fail purely because the two words are on different lines.
 *
 * Compiling with the same flags the compiler validates against is deliberate:
 * "it compiled at build time" then actually means "it compiles at run time".
 *
 * A malformed pattern still fails closed rather than throwing, so one bad
 * recording surfaces as a debuggable checkpoint failure instead of a crash —
 * but it can no longer reach production silently, because `validateCapability`
 * rejects an artifact containing one.
 */
function safeRegex(pattern: string, flags = 'is'): RegExp | undefined {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return undefined;
  }
}

export function matchMode(m: NameMatch | undefined): NameMatch {
  return m ?? 'normalized';
}
