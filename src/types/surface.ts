/**
 * The surface port — the seam between "how we perceive and act on a thing" and
 * "the recorded flow".
 *
 * Everything above this interface (agent loop, artifact compiler, replay
 * engine, resolver, policy, escalation) is surface-agnostic. Everything below
 * it is one adapter. Adding a desktop surface means implementing `Surface`;
 * it means changing nothing else.
 *
 * That is only true because of what `UiNode` contains. Note what is NOT in it:
 * no CSS selector, no XPath, no DOM handle, no HTML. The node is the same
 * abstraction a screen reader gets — role, name, value, structural position —
 * which is precisely the abstraction that exists on Windows UI Automation,
 * macOS AX, and the browser accessibility tree alike. The web adapter derives
 * these from the a11y tree plus DOM structure; a desktop adapter would derive
 * the identical shape from UIA's `AutomationElement`.
 *
 * `handle` is ephemeral and snapshot-scoped by design. The model refers to
 * `e17`; `e17` means nothing five seconds later and is never written to an
 * artifact. Persistence goes through ElementDescriptor, which is semantic.
 */

import type { ControlRole } from './artifact.js';

export interface UiNode {
  /** Snapshot-scoped opaque id. The only thing the model ever names. */
  handle: string;
  role: ControlRole;

  /** Accessible name, when the app provides one. Often empty on legacy apps. */
  name: string;

  /**
   * The label a human reads for this control, derived from structure when
   * there is no accessible name: adjacent table cell, preceding sibling text,
   * wrapping fieldset legend, column header. This field is what makes legacy
   * table-layout apps addressable at all.
   */
  label: string;

  /** How `label` was obtained — recorded so descriptor quality is auditable. */
  labelSource: 'accessible-name' | 'label-for' | 'table-cell' | 'preceding-text' | 'column-header' | 'legend' | 'none';

  /** Current value for inputs/selects. Masked upstream when sensitive. */
  value?: string;

  /** Nearest enclosing titled region: panel header, legend, table caption. */
  container?: string;

  /** Frame path from the top document. Empty array = top document. */
  framePath: string[];

  /** Index among nodes with the same (role, name, label, container). */
  ordinal: number;

  /**
   * Grid coordinates, populated for table cells.
   *
   * Reading a value out of a data grid is a two-dimensional lookup — "the
   * Current Balance of the SAVINGS row" — and neither axis alone identifies
   * it. Carrying both means an extraction rule can be written the way an
   * operator would say it, instead of as a cell index that breaks the moment
   * a column is reordered.
   */
  rowKey?: string;
  columnHeader?: string;

  visible: boolean;
  enabled: boolean;

  /** Recorded for drift forensics; never used as a matching signal. */
  hints: {
    domId?: string;
    inputType?: string;
    placeholder?: string;
    href?: string;
    tag?: string;
  };

  /** Viewport-relative box, used for screenshot masking. */
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface SurfaceSnapshot {
  capturedAt: string;
  url: string;
  title: string;
  /** Interactive + textual nodes worth reasoning about. Pruned, not raw. */
  nodes: UiNode[];
  /** Flattened visible text across all frames, for text conditions. */
  text: string;
  /** Last HTTP status observed for a main-frame navigation, if known. */
  lastStatus?: number;
}

/** The action vocabulary. Deliberately small — every entry is policy-gated. */
export type SurfaceAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; handle: string }
  | { kind: 'type'; handle: string; text: string; clearFirst: boolean }
  | { kind: 'select'; handle: string; value: string }
  | { kind: 'press'; key: string };

export interface ScreenshotOptions {
  /** Regions to paint over before the image is written to disk. */
  maskBounds?: Array<{ x: number; y: number; width: number; height: number }>;
  fullPage?: boolean;
}

/**
 * A surface implementation.
 *
 * Implementations must treat `acquire`/`release` as a hard mutex: while the
 * lease is held by the operator, every mutating call must reject. That is what
 * makes the human handoff safe rather than a race.
 */
export interface Surface {
  readonly kind: 'web' | 'legacy_web' | 'desktop' | 'terminal';

  snapshot(): Promise<SurfaceSnapshot>;
  act(action: SurfaceAction): Promise<void>;
  screenshot(opts?: ScreenshotOptions): Promise<Buffer>;
  /** Raw markup / UI dump for failure forensics. Redacted before it is saved. */
  dump(): Promise<string>;
  currentUrl(): Promise<string>;
  close(): Promise<void>;
}

/** Whitespace and case normalisation applied to every name/label comparison. */
export function normalizeText(s: string | undefined | null): string {
  return String(s ?? '')
    .replace(/[   ]/g, ' ')
    .replace(/[\s\r\n\t]+/g, ' ')
    .replace(/[:*]\s*$/, '')
    .trim()
    .toLowerCase();
}
