/**
 * The web surface adapter.
 *
 * Playwright is used purely as a *driver* here — to move a mouse, type keys,
 * and read the frame tree. It is deliberately not used as a locator engine:
 * `page.getByRole()` and friends never appear, because a recorded flow that
 * depends on Playwright's matching semantics is a flow that cannot move to a
 * desktop surface. Everything above this file sees only `UiNode` and handles.
 *
 * The browser runs headed by default and with a persistent context. Both are
 * requirements of the escalation model rather than conveniences: a human takes
 * control of *this* window, in *this* session, with the form still half-filled.
 */

import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright';
import type { ScreenshotOptions, Surface, SurfaceAction, SurfaceSnapshot } from '../../types/surface.js';
import { snapshotPage } from './perception.js';
import type { SessionLease } from '../../control/lease.js';

/** Shape emitted by the in-page operator-action listener. */
export interface RawHumanAction {
  at: string;
  type: 'click' | 'change' | 'submit';
  url?: string;
  target?: string;
  role?: string;
  label?: string;
  value?: string;
}

export interface PlaywrightSurfaceOptions {
  headless?: boolean;
  /** Every mutating action is gated on this lease. See control/lease.ts. */
  lease: SessionLease;
  viewport?: { width: number; height: number };
  defaultTimeoutMs?: number;
  /** Called with each main-frame response so snapshots can carry HTTP status. */
  onNavigation?: (url: string, status: number) => void;
}

export class PlaywrightSurface implements Surface {
  readonly kind = 'legacy_web' as const;

  private browser!: Browser;
  private context!: BrowserContext;
  private page!: Page;
  private lastStatus: number | undefined;
  private readonly opts: PlaywrightSurfaceOptions;

  /** Guards against re-exposing the operator-capture binding on a re-escalation. */
  private humanCaptureArmed = false;
  private humanActionSink: ((a: RawHumanAction) => void) | undefined;

  private constructor(opts: PlaywrightSurfaceOptions) {
    this.opts = opts;
  }

  static async launch(opts: PlaywrightSurfaceOptions): Promise<PlaywrightSurface> {
    const s = new PlaywrightSurface(opts);
    s.browser = await chromium.launch({
      headless: opts.headless ?? false,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    s.context = await s.browser.newContext({
      viewport: opts.viewport ?? { width: 1360, height: 900 },
      // Legacy intranet apps are routinely served over plain http with
      // self-signed certs on internal hosts.
      ignoreHTTPSErrors: true,
    });
    s.context.setDefaultTimeout(opts.defaultTimeoutMs ?? 8000);
    s.page = await s.context.newPage();

    s.page.on('response', (res: Response) => {
      if (res.frame() === s.page.mainFrame() && res.request().resourceType() === 'document') {
        s.lastStatus = res.status();
        opts.onNavigation?.(res.url(), res.status());
      }
    });

    return s;
  }

  /** Exposed so the operator console can stream frames of the live session. */
  get livePage(): Page {
    return this.page;
  }

  /**
   * Record what a human does while they hold the lease.
   *
   * The brief asks that we capture the operator's actions across the handoff.
   * Doing it with a DOM event listener rather than by diffing screenshots gets
   * us the same semantic vocabulary the automation uses — role, label,
   * container — which means a human demonstration is expressible as artifact
   * steps. That is the basis for "promote this manual fix into the capability",
   * noted as future work in REPORT.md; today it produces an audit trail.
   *
   * Value capture is filtered at the source: password fields report that they
   * were filled, never with what.
   */
  async captureHumanActions(onAction: (a: RawHumanAction) => void): Promise<void> {
    // Idempotent: a single run can escalate more than once, and Playwright
    // throws if the same binding is exposed twice. The listener is rebound to
    // the newest callback so each intervention records its own actions.
    this.humanActionSink = onAction;
    if (this.humanCaptureArmed) return;
    this.humanCaptureArmed = true;

    await this.context.exposeFunction('__hsOperatorEvent', (a: RawHumanAction) => {
      this.humanActionSink?.(a);
    });

    const script = () => {
      const NORM = (s: string | null | undefined): string => String(s ?? '').replace(/\s+/g, ' ').trim();

      const describe = (el: Element): { role: string; label: string; target: string } => {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') ?? '').toLowerCase();
        let role = tag;
        if (tag === 'a') role = 'link';
        else if (tag === 'button' || type === 'submit' || type === 'button') role = 'button';
        else if (tag === 'select') role = 'combobox';
        else if (tag === 'input' || tag === 'textarea') role = 'textbox';

        let label = NORM(el.getAttribute('aria-label'));
        if (!label && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
          const id = el.getAttribute('id');
          if (id) {
            const labels = document.getElementsByTagName('label');
            for (let i = 0; i < labels.length; i++) {
              if (labels[i]!.getAttribute('for') === id) {
                label = NORM(labels[i]!.textContent);
                break;
              }
            }
          }
          if (!label) {
            const cell = el.closest('td, th');
            const prev = cell?.previousElementSibling;
            if (prev && !prev.querySelector('input,select,textarea')) label = NORM(prev.textContent);
          }
        }
        if (!label) label = NORM((el as HTMLInputElement).value) || NORM(el.textContent).slice(0, 60);
        return { role, label, target: `${role} "${label}"` };
      };

      const send = (payload: Record<string, unknown>): void => {
        const w = window as unknown as { __hsOperatorEvent?: (p: unknown) => void };
        try {
          w.__hsOperatorEvent?.({ at: new Date().toISOString(), url: location.href, ...payload });
        } catch {
          /* binding not present in this frame yet */
        }
      };

      document.addEventListener(
        'click',
        (e) => {
          const el = e.target as Element | null;
          if (!el || !el.tagName) return;
          const d = describe(el);
          send({ type: 'click', ...d });
        },
        true,
      );

      document.addEventListener(
        'change',
        (e) => {
          const el = e.target as HTMLInputElement | null;
          if (!el || !el.tagName) return;
          const d = describe(el);
          const isSecret = (el.getAttribute('type') ?? '').toLowerCase() === 'password';
          send({ type: 'change', ...d, value: isSecret ? '[entered]' : NORM(el.value).slice(0, 80) });
        },
        true,
      );

      document.addEventListener(
        'submit',
        (e) => {
          const el = e.target as Element | null;
          send({ type: 'submit', target: `form ${NORM(el?.getAttribute('action'))}` });
        },
        true,
      );
    };

    await this.context.addInitScript(script);
    // Init scripts only apply to future navigations, so arm the frames that
    // are already loaded.
    for (const frame of this.page.frames()) {
      await frame.evaluate(script).catch(() => undefined);
    }
  }

  async snapshot(): Promise<SurfaceSnapshot> {
    // Snapshots are read-only and intentionally NOT lease-gated: the harness
    // must keep observing while a human drives, so we can record what they did.
    await this.settle();
    return snapshotPage(this.page, this.lastStatus);
  }

  async act(action: SurfaceAction): Promise<void> {
    // The enforcement point for control transfer. If an operator holds the
    // lease this throws, no matter what the caller believes.
    this.opts.lease.assertHeldBy('automation');

    switch (action.kind) {
      case 'navigate': {
        const res = await this.page.goto(action.url, { waitUntil: 'domcontentloaded' });
        if (res) this.lastStatus = res.status();
        break;
      }
      case 'click': {
        const el = await this.locate(action.handle);
        // `scrollIntoViewIfNeeded` first: legacy pages are long and Playwright's
        // auto-scroll occasionally lands on a sticky header.
        await el.scrollIntoViewIfNeeded().catch(() => undefined);
        // `noWaitAfter`: do not block the click on the navigation it triggers.
        //
        // A full-page postback on a loaded core system can take longer than any
        // sensible click timeout, and a slow *server* is not a failed *click*.
        // Blocking here also duplicates the step checkpoint with strictly worse
        // semantics — the checkpoint is the authority on whether the action took
        // effect, and it polls a real condition instead of a network heuristic.
        await el.click({ timeout: this.opts.defaultTimeoutMs ?? 8000, noWaitAfter: true });
        break;
      }
      case 'type': {
        const el = await this.locate(action.handle);
        await el.scrollIntoViewIfNeeded().catch(() => undefined);
        if (action.clearFirst) await el.fill('');
        // `pressSequentially` rather than `fill`: WebForms controls frequently
        // hang validation and auto-postback logic off keystroke events, and
        // `fill` sets `.value` without firing them.
        await el.pressSequentially(action.text, { delay: 12 });
        break;
      }
      case 'select': {
        const el = await this.locate(action.handle);
        // Try by value, then by visible label — tenants differ on which is
        // stable, and the artifact records the human-visible one.
        try {
          await el.selectOption({ value: action.value });
        } catch {
          await el.selectOption({ label: action.value });
        }
        break;
      }
      case 'press': {
        await this.page.keyboard.press(action.key);
        break;
      }
    }

    await this.settle();
  }

  async screenshot(opts: ScreenshotOptions = {}): Promise<Buffer> {
    // Sensitive regions are painted over *in the browser* before the pixels are
    // captured, so an unredacted image never exists on disk or in memory.
    const overlayId = '__hs_mask_layer';
    if (opts.maskBounds?.length) {
      await this.page
        .evaluate((boxes: Array<{ x: number; y: number; width: number; height: number }>) => {
          const prev = document.getElementById('__hs_mask_layer');
          prev?.remove();
          const layer = document.createElement('div');
          layer.id = '__hs_mask_layer';
          layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
          for (const b of boxes) {
            const d = document.createElement('div');
            d.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;background:#111;`;
            layer.appendChild(d);
          }
          document.body.appendChild(layer);
        }, opts.maskBounds)
        .catch(() => undefined);
    }

    const buf = await this.page.screenshot({ fullPage: opts.fullPage ?? false });

    if (opts.maskBounds?.length) {
      await this.page
        .evaluate((id: string) => document.getElementById(id)?.remove(), overlayId)
        .catch(() => undefined);
    }
    return buf;
  }

  async dump(): Promise<string> {
    const parts: string[] = [];
    for (const frame of this.page.frames()) {
      if (frame.isDetached()) continue;
      try {
        const html = await frame.content();
        parts.push(`<!-- ===== frame: ${frame.name() || frame.url()} ===== -->\n${html}`);
      } catch {
        /* frame gone mid-dump */
      }
    }
    return parts.join('\n\n');
  }

  async currentUrl(): Promise<string> {
    return this.page.url();
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
  }

  /**
   * Resolve a snapshot handle to something clickable.
   *
   * Handles are stamped as `data-hs-h` during the snapshot and cleared on the
   * next one, so a handle is only valid against the snapshot that produced it.
   * A stale handle therefore fails loudly here rather than silently acting on
   * whatever now occupies that position — which is the behaviour you want.
   */
  private async locate(handle: string) {
    for (const frame of this.page.frames()) {
      if (frame.isDetached()) continue;
      const loc = frame.locator(`[data-hs-h="${handle}"]`);
      if ((await loc.count()) > 0) return loc.first();
    }
    throw new Error(
      `Handle "${handle}" is no longer present on the page. Handles are valid only for the snapshot that produced them; take a fresh snapshot.`,
    );
  }

  /**
   * Wait for the page to stop moving.
   *
   * Deliberately condition-based rather than a fixed sleep. Legacy apps do
   * full-page postbacks, so `domcontentloaded` on the main frame plus a short
   * network-idle window covers the real cases; the `catch` matters because
   * `networkidle` never fires on pages that hold a long-poll open, and hanging
   * forever is worse than proceeding and letting the checkpoint decide.
   */
  private async settle(): Promise<void> {
    // A short beat first, so a navigation the action just triggered has
    // actually been *registered* before we ask whether the page is idle.
    // Without it `networkidle` can resolve against the pre-navigation page and
    // the caller snapshots mid-flight.
    //
    // This is not a substitute for waiting — the step checkpoint polls a real
    // condition and is the authority on whether the action took effect. It
    // only prevents the very first observation from being taken a moment too
    // early, which otherwise makes a loose checkpoint pass for the wrong
    // reason.
    await this.page.waitForTimeout(120);
    await this.page.waitForLoadState('domcontentloaded').catch(() => undefined);

    // Wait for CHILD FRAMES too, not just the page.
    //
    // A page-level load state says nothing about whether an iframe has finished
    // loading, and in a frameset app the content that matters is always in the
    // child. Without this the whole system is racy in a way that is very hard
    // to see: an interstitial rendered inside the frame is present for one
    // snapshot and absent for the next, so a global guard fires on some runs
    // and not others. It presented as "this recoverable outcome is unverified"
    // while a manual run of the identical scenario recovered perfectly.
    await Promise.all(
      this.page
        .frames()
        .map((f) => (f.isDetached() ? Promise.resolve() : f.waitForLoadState('domcontentloaded').catch(() => undefined))),
    );

    await this.page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => undefined);
  }
}
