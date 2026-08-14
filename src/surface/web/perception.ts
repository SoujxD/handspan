/**
 * Web perception: turn a live page (across all frames) into a normalized
 * `UiNode[]`.
 *
 * The hard part is not enumerating elements — it is producing a *label* for
 * controls that have no accessible name. In a modern app, `<label for>` and
 * `aria-label` do the work. In the apps this system actually targets, a text
 * box's only human-visible label is the text in the table cell to its left,
 * and its `id` is `ctl00$MainContent$txtMbr`, which changes between tenant
 * skins. So the derivation ladder below is the substance of the adapter:
 *
 *   1. accessible name          (aria-label / aria-labelledby / alt / content)
 *   2. <label for> or wrapping <label>
 *   3. adjacent table cell      <-- the one that carries legacy apps
 *   4. column header for the cell's column
 *   5. preceding text in the same block
 *   6. enclosing <legend> / <caption>
 *
 * Every node records WHICH rung produced its label (`labelSource`), so the
 * artifact compiler can prefer high-confidence descriptors and a reviewer can
 * see when a capability is leaning on something fragile.
 *
 * A note on the `data-hs-h` attribute: we stamp a transient handle onto each
 * element so that resolve-and-act is atomic against one snapshot. Handles are
 * cleared and reissued on every snapshot, and never reach an artifact.
 */

import type { Frame, Page } from 'playwright';
import type { SurfaceSnapshot, UiNode } from '../../types/surface.js';

/** Raw shape returned from the browser context. */
interface RawNode {
  handle: string;
  role: string;
  name: string;
  label: string;
  labelSource: UiNode['labelSource'];
  value?: string;
  rowKey?: string;
  columnHeader?: string;
  container?: string;
  visible: boolean;
  enabled: boolean;
  domId?: string;
  inputType?: string;
  placeholder?: string;
  href?: string;
  tag: string;
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * Runs inside the page. Must be fully self-contained — no imports, no closure
 * over module scope.
 */
/* c8 ignore start -- executed in the browser context, covered by integration runs */
function collectNodes(startIndex: number): { nodes: RawNode[]; text: string } {
  const NORM = (s: string | null | undefined): string =>
    String(s ?? '')
      .replace(/[   ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  // Clear handles from any previous snapshot so stale ids can never resolve.
  document.querySelectorAll('[data-hs-h]').forEach((e) => e.removeAttribute('data-hs-h'));

  const isVisible = (el: Element): boolean => {
    const st = window.getComputedStyle(el as HTMLElement);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    if ((el as HTMLInputElement).type === 'hidden') return false;
    return true;
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'text';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'td') return 'cell';
    if (tag === 'th') return 'cell';
    if (tag === 'table') return 'table';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'img') return 'image';
    if (tag === 'legend' || tag === 'caption') return 'heading';
    return 'text';
  };

  /** Text of an element with form controls and nested tables stripped out. */
  const ownText = (el: Element): string => {
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('input,select,textarea,button,table,script,style').forEach((n) => n.remove());
    return NORM(clone.textContent);
  };

  // --- rung 1: accessible name ------------------------------------------
  const accessibleName = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria && NORM(aria)) return NORM(aria);

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => NORM(n!.textContent));
      if (parts.join(' ').trim()) return NORM(parts.join(' '));
    }

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') ?? '').toLowerCase();

    // Submit/button inputs carry their name in `value` — the single most
    // common "button" in WebForms apps.
    if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
      return NORM((el as HTMLInputElement).value);
    }
    if (tag === 'input' && type === 'image') return NORM(el.getAttribute('alt'));
    if (tag === 'img') return NORM(el.getAttribute('alt'));
    if (tag === 'a' || tag === 'button') {
      const t = ownText(el);
      if (t) return t;
      const img = el.querySelector('img[alt]');
      if (img) return NORM(img.getAttribute('alt'));
    }
    const title = el.getAttribute('title');
    if (title && NORM(title)) return NORM(title);
    return '';
  };

  // --- rung 2: <label for> / wrapping <label> ---------------------------
  const explicitLabel = (el: Element): string => {
    const id = el.getAttribute('id');
    if (id) {
      // getElementById can't be used for ids containing `$` in a selector,
      // but the DOM API itself is fine with them.
      const all = document.getElementsByTagName('label');
      for (let i = 0; i < all.length; i++) {
        const l = all[i]!;
        if (l.getAttribute('for') === id) return NORM(l.textContent);
      }
    }
    const wrapping = el.closest('label');
    if (wrapping) return ownText(wrapping);
    return '';
  };

  // --- rung 3: adjacent table cell --------------------------------------
  // `<td>Member ID</td><td><input ...></td>` — the defining legacy pattern.
  const adjacentCellLabel = (el: Element): string => {
    const cell = el.closest('td, th');
    if (!cell) return '';
    let prev = cell.previousElementSibling;
    while (prev) {
      const t = ownText(prev);
      // A neighbouring cell that itself contains a control is a peer field,
      // not a label for this one.
      if (t && !prev.querySelector('input,select,textarea,button')) return t;
      prev = prev.previousElementSibling;
    }
    // Some layouts put the label in the row above rather than to the left.
    const row = cell.closest('tr');
    const prevRow = row?.previousElementSibling;
    if (prevRow) {
      const idx = Array.prototype.indexOf.call(row!.children, cell);
      const above = prevRow.children[idx];
      if (above && !above.querySelector('input,select,textarea,button')) {
        const t = ownText(above);
        if (t) return t;
      }
    }
    return '';
  };

  // --- rung 4: column header --------------------------------------------
  const columnHeaderLabel = (el: Element): string => {
    const cell = el.closest('td, th');
    const row = cell?.closest('tr');
    const table = cell?.closest('table');
    if (!cell || !row || !table) return '';
    const idx = Array.prototype.indexOf.call(row.children, cell);
    const headerRow = table.querySelector('tr');
    if (!headerRow || headerRow === row) return '';
    const header = headerRow.children[idx];
    return header ? ownText(header) : '';
  };

  // --- rung 5: preceding text in the same block -------------------------
  const precedingTextLabel = (el: Element): string => {
    let prev = el.previousSibling;
    while (prev) {
      if (prev.nodeType === Node.TEXT_NODE) {
        const t = NORM(prev.textContent);
        if (t) return t;
      } else if (prev.nodeType === Node.ELEMENT_NODE) {
        const e = prev as Element;
        if (!e.querySelector('input,select,textarea,button')) {
          const t = ownText(e);
          if (t) return t;
        }
        break;
      }
      prev = prev.previousSibling;
    }
    return '';
  };

  // --- rung 6: legend / caption -----------------------------------------
  const legendLabel = (el: Element): string => {
    const fs = el.closest('fieldset');
    const legend = fs?.querySelector('legend');
    if (legend) return ownText(legend);
    const table = el.closest('table');
    const caption = table?.querySelector('caption');
    if (caption) return ownText(caption);
    return '';
  };

  /**
   * Does this cell live in a data grid (a table with a header row) rather than
   * a form-layout table? The distinction decides which rung wins.
   *
   * In a form table (`<td>Member ID</td><td><input></td>`) the label is the
   * cell to the left. In a data grid the cell to the left is a *different
   * column's value*, and the label is the column header. Getting this backwards
   * makes every grid read return the wrong field, so it is worth the check.
   */
  const inDataGrid = (el: Element): boolean => {
    const table = el.closest('table');
    if (!table) return false;
    return !!table.querySelector('tr th');
  };

  /** Text of the row's first cell — the natural row identifier in a grid. */
  const rowKeyOf = (el: Element): string => {
    const row = el.closest('tr');
    if (!row) return '';
    const first = row.children[0];
    return first ? ownText(first) : '';
  };

  const deriveLabel = (el: Element): { label: string; source: UiNode['labelSource'] } => {
    let v = accessibleName(el);
    if (v) return { label: v, source: 'accessible-name' };
    v = explicitLabel(el);
    if (v) return { label: v, source: 'label-for' };

    // Order flips inside a data grid; see `inDataGrid`.
    if (inDataGrid(el)) {
      v = columnHeaderLabel(el);
      if (v) return { label: v, source: 'column-header' };
      v = adjacentCellLabel(el);
      if (v) return { label: v, source: 'table-cell' };
    } else {
      v = adjacentCellLabel(el);
      if (v) return { label: v, source: 'table-cell' };
      v = columnHeaderLabel(el);
      if (v) return { label: v, source: 'column-header' };
    }

    v = precedingTextLabel(el);
    if (v) return { label: v, source: 'preceding-text' };
    v = legendLabel(el);
    if (v) return { label: v, source: 'legend' };
    return { label: '', source: 'none' };
  };

  /**
   * Nearest enclosing titled region.
   *
   * Generic rather than app-specific: walk up, and at each ancestor look for a
   * heading-ish element that precedes the branch we came from. This picks up
   * <h*>, <legend>, <caption>, and the "styled div acting as a panel header"
   * pattern that every enterprise app reinvents.
   */
  const findContainer = (el: Element): string => {
    let node: Element | null = el;
    // Depth has to be generous. Legacy layouts nest tables three deep, and the
    // browser silently inserts a <tbody> at every level, so a control inside a
    // form table inside a layout table is already ~9 ancestors from its panel
    // header. A tighter bound quietly drops the container on exactly the dense
    // screens where it is most needed for disambiguation.
    for (let depth = 0; depth < 14 && node; depth++) {
      const parent: Element | null = node.parentElement;
      if (!parent) break;
      const aria = parent.getAttribute('aria-label');
      if (aria && NORM(aria)) return NORM(aria);

      const siblings = Array.prototype.slice.call(parent.children) as Element[];
      const selfIdx = siblings.indexOf(node);
      for (let i = selfIdx - 1; i >= 0; i--) {
        const cand = siblings[i]!;
        const tag = cand.tagName.toLowerCase();

        // A sibling <td> is a peer field's value, not a title for this region.
        // Without this the "container" of every cell becomes the text of the
        // cell above or to its left, which is both wrong and actively harmful:
        // the resolver would then score `container` against noise and the
        // descriptor would not survive a row being added.
        if (TABLE_STRUCTURE.has(tag)) continue;

        const headingish = /^h[1-6]$/.test(tag) || tag === 'legend' || tag === 'caption';
        const looksLikeTitle =
          !cand.querySelector('input,select,textarea,table') &&
          NORM(cand.textContent).length > 0 &&
          NORM(cand.textContent).length <= 60;
        if (headingish || looksLikeTitle) {
          const t = NORM(cand.textContent);
          if (t && /[a-z0-9]/i.test(t)) return t;
        }
      }
      node = parent;
    }
    return '';
  };

  const TABLE_STRUCTURE = new Set(['td', 'th', 'tr', 'tbody', 'thead', 'tfoot', 'table', 'colgroup', 'col']);

  const INTERACTIVE = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick]';
  const READABLE = 'h1, h2, h3, h4, h5, h6, td, th, legend, caption';

  /** Text that carries no information — spacers, arrows, rule characters. */
  const isDecorative = (t: string): boolean => !/[a-z0-9]/i.test(t);

  const seen = new Set<Element>();
  const out: RawNode[] = [];
  let i = startIndex;

  const push = (el: Element, forceInclude: boolean): void => {
    if (seen.has(el)) return;
    seen.add(el);

    const visible = isVisible(el);
    if (!visible && !forceInclude) return;

    const role = roleOf(el);
    const tag = el.tagName.toLowerCase();

    // Readable cells are only worth carrying if they hold short, label-like or
    // value-like text. Whole-table cells full of nested markup are noise.
    if (!forceInclude) {
      const t = ownText(el);
      if (!t || t.length > 160) return;
      // Layout cells holding only »/·/— are pure noise in the observation the
      // model reads, and noise in that list costs tokens and attention.
      if (isDecorative(t)) return;
      // A cell that merely wraps a control adds nothing the control doesn't.
      if ((tag === 'td' || tag === 'th') && el.querySelector('input,select,textarea,button')) return;
    }

    const { label, source } = deriveLabel(el);
    const name = accessibleName(el);
    const r = el.getBoundingClientRect();
    const type = (el.getAttribute('type') ?? '').toLowerCase();

    let value: string | undefined;
    if (tag === 'input' && type !== 'submit' && type !== 'button' && type !== 'password') {
      value = (el as HTMLInputElement).value || undefined;
    } else if (tag === 'password' || type === 'password') {
      value = undefined; // never read back a password field
    } else if (tag === 'select') {
      const sel = el as HTMLSelectElement;
      value = sel.options[sel.selectedIndex]?.text ?? undefined;
    } else if (tag === 'textarea') {
      value = (el as HTMLTextAreaElement).value || undefined;
    } else if (role === 'cell' || role === 'heading') {
      value = ownText(el) || undefined;
    }

    const handle = `e${i++}`;
    el.setAttribute('data-hs-h', handle);

    const isCell = tag === 'td' || tag === 'th';

    out.push({
      handle,
      role,
      name,
      label,
      labelSource: source,
      value,
      rowKey: isCell ? rowKeyOf(el) || undefined : undefined,
      columnHeader: isCell ? columnHeaderLabel(el) || undefined : undefined,
      container: findContainer(el) || undefined,
      visible,
      enabled: !(el as HTMLInputElement).disabled,
      domId: el.getAttribute('id') ?? undefined,
      inputType: type || undefined,
      placeholder: el.getAttribute('placeholder') ?? undefined,
      href: el.getAttribute('href') ?? undefined,
      tag,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    });
  };

  document.querySelectorAll(INTERACTIVE).forEach((el) => push(el, true));
  document.querySelectorAll(READABLE).forEach((el) => push(el, false));

  const bodyClone = document.body ? (document.body.cloneNode(true) as HTMLElement) : null;
  bodyClone?.querySelectorAll('script,style').forEach((n) => n.remove());

  return { nodes: out, text: NORM(bodyClone?.innerText ?? bodyClone?.textContent ?? '') };
}
/* c8 ignore stop */

/** Human-readable path for a frame, used as the descriptor's `framePath`. */
function frameLabel(frame: Frame): string {
  const name = frame.name();
  if (name) return name;
  try {
    const u = new URL(frame.url());
    return u.pathname;
  } catch {
    return frame.url();
  }
}

/**
 * Snapshot every frame and merge into one normalized view.
 *
 * Frames are traversed depth-first from the main frame so `framePath` reads
 * top-down, which is how a human would describe it ("in the main frame").
 */
export async function snapshotPage(page: Page, lastStatus?: number): Promise<SurfaceSnapshot> {
  const nodes: UiNode[] = [];
  const texts: string[] = [];
  let index = 1;

  const frames = page.frames();

  for (const frame of frames) {
    if (frame.isDetached()) continue;

    // Frame path = labels of every ancestor frame, excluding the main frame.
    const path: string[] = [];
    let f: Frame | null = frame;
    while (f && f.parentFrame()) {
      path.unshift(frameLabel(f));
      f = f.parentFrame();
    }

    // Offset frame-local coordinates into page space so screenshot masking of
    // sensitive regions works for content inside iframes too.
    let offsetX = 0;
    let offsetY = 0;
    if (frame.parentFrame()) {
      try {
        const el = await frame.frameElement();
        const box = await el.boundingBox();
        if (box) {
          offsetX = box.x;
          offsetY = box.y;
        }
        await el.dispose();
      } catch {
        /* frame detached mid-snapshot; coordinates simply stay frame-local */
      }
    }

    let raw: { nodes: RawNode[]; text: string };
    try {
      // Playwright serialises `collectNodes` with `.toString()` and evals it in
      // the page. TypeScript runners built on esbuild (tsx, and Vitest's
      // transform) compile with `keepNames`, which rewrites every function
      // declaration as `__name(function f(){...}, "f")` — a helper that exists
      // in the Node bundle and not in the browser. The serialised source
      // therefore throws `ReferenceError: __name is not defined` inside the
      // page, and the collector returns nothing.
      //
      // Shimming it as identity is the smallest fix that does not require
      // build-tool configuration, and it keeps the collector readable as a
      // normal function rather than a string blob.
      await frame.evaluate('globalThis.__name = globalThis.__name || ((f) => f)');
      raw = await frame.evaluate(collectNodes, index);
    } catch (e) {
      // Frames navigate out from under you constantly in legacy apps, so a
      // frame that vanishes mid-snapshot is normal. Anything else is a real
      // bug in the collector and must not be swallowed silently — an empty
      // snapshot looks exactly like "the page has no controls", which is the
      // most misleading failure this module could produce.
      const msg = (e as Error).message ?? '';
      const detached = /detached|Execution context was destroyed|Target closed|frame was detached/i.test(msg);
      if (!detached) {
        // eslint-disable-next-line no-console
        console.warn(`  [perception] collector failed on frame ${frame.url()}: ${msg}`);
      }
      continue;
    }

    index += raw.nodes.length;
    if (raw.text) texts.push(raw.text);

    // Ordinal is assigned per identity group so a descriptor can disambiguate
    // "the second Amount box" without ever naming a DOM position.
    const groupCounts = new Map<string, number>();
    for (const n of raw.nodes) {
      const key = `${n.role}|${n.name}|${n.label}|${n.container ?? ''}|${path.join('/')}`;
      const ordinal = groupCounts.get(key) ?? 0;
      groupCounts.set(key, ordinal + 1);

      nodes.push({
        handle: n.handle,
        role: normalizeRole(n.role),
        name: n.name,
        label: n.label,
        labelSource: n.labelSource,
        value: n.value,
        rowKey: n.rowKey,
        columnHeader: n.columnHeader,
        container: n.container,
        framePath: path,
        ordinal,
        visible: n.visible,
        enabled: n.enabled,
        hints: {
          domId: n.domId,
          inputType: n.inputType,
          placeholder: n.placeholder,
          href: n.href,
          tag: n.tag,
        },
        bounds: {
          x: n.rect.x + offsetX,
          y: n.rect.y + offsetY,
          width: n.rect.width,
          height: n.rect.height,
        },
      });
    }
  }

  return {
    capturedAt: new Date().toISOString(),
    url: page.url(),
    title: await page.title().catch(() => ''),
    nodes,
    text: texts.join('\n'),
    lastStatus,
  };
}

const ROLE_ALLOW = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'tab', 'menuitem',
  'cell', 'row', 'heading', 'text', 'region', 'dialog', 'table', 'list', 'listitem', 'image',
]);

function normalizeRole(role: string): UiNode['role'] {
  const r = role.toLowerCase();
  if (ROLE_ALLOW.has(r)) return r as UiNode['role'];
  if (r === 'searchbox' || r === 'spinbutton') return 'textbox';
  if (r === 'listbox' || r === 'select') return 'combobox';
  if (r === 'gridcell' || r === 'columnheader' || r === 'rowheader') return 'cell';
  return 'unknown';
}
