/**
 * Redaction.
 *
 * The rule this module enforces: regulated data may be *read* by the system in
 * order to do its job, but it must not be *persisted*. Artifacts, JSONL logs,
 * screenshots, DOM dumps, and the outputs returned to a caller all pass through
 * here on their way out of the process.
 *
 * Two mechanisms, because either alone is insufficient:
 *
 *   Pattern redaction  catches values nobody declared — an SSN that happens to
 *                      appear in a page dump. Necessary but not sufficient: it
 *                      is a heuristic and will miss things.
 *   Runtime scrubbing  catches declared secrets by exact substring, registered
 *                      when a `secret`-classified input is bound. This is the
 *                      guarantee. A password can never survive a log even if
 *                      it matches no regex, because we know its exact value.
 *
 * The ordering matters: scrub first (exact, certain), then patterns
 * (heuristic), so a declared secret is never merely partially masked by a
 * pattern that happens to overlap it.
 */

export interface RedactionPattern {
  name: string;
  regex: string;
  replacement: string;
}

export interface RedactionStats {
  /** How many times each rule fired. Surfaced in the run summary so a spike in
   *  redactions is visible rather than silent. */
  hits: Record<string, number>;
}

export class Redactor {
  private readonly compiled: Array<{ name: string; re: RegExp; replacement: string }>;
  /** Exact values registered at runtime. Never itself logged. */
  private readonly secrets = new Set<string>();
  private readonly stats: RedactionStats = { hits: {} };

  constructor(
    patterns: RedactionPattern[],
    private readonly scrubRuntimeSecrets = true,
  ) {
    // `gi`, not `g`: redaction patterns must be case-insensitive for the same
    // reason risk patterns are — "Authorization:" and "AUTHORIZATION:" are the
    // same secret, and a pattern that only catches one of them is worse than
    // no pattern, because it looks like it is working.
    this.compiled = patterns.map((p) => {
      try {
        return { name: p.name, re: new RegExp(p.regex, 'gi'), replacement: p.replacement };
      } catch (e) {
        throw new Error(
          `policy.yaml: invalid redaction pattern "${p.name}": /${p.regex}/ — ${(e as Error).message}. ` +
            `ECMAScript has no inline flags such as (?i); these are compiled case-insensitively already.`,
        );
      }
    });
  }

  /**
   * Register a value that must never appear in output.
   *
   * Short values are refused deliberately: registering "a" would scrub every
   * letter 'a' in every log line, which destroys the evidence trail while
   * looking like it is working.
   */
  registerSecret(value: string): void {
    if (!this.scrubRuntimeSecrets) return;
    if (!value || value.length < 4) return;
    this.secrets.add(value);
  }

  get secretCount(): number {
    return this.secrets.size;
  }

  get redactionStats(): RedactionStats {
    return { hits: { ...this.stats.hits } };
  }

  /** Redact a string. Safe to call on anything, including already-redacted text. */
  text(input: string): string {
    if (!input) return input;
    let out = input;

    for (const s of this.secrets) {
      if (out.includes(s)) {
        out = out.split(s).join('[REDACTED:SECRET]');
        this.bump('runtime_secret');
      }
    }

    for (const p of this.compiled) {
      p.re.lastIndex = 0;
      if (p.re.test(out)) {
        p.re.lastIndex = 0;
        out = out.replace(p.re, p.replacement);
        this.bump(p.name);
      }
    }

    return out;
  }

  /**
   * Deep-redact an arbitrary structure. Used on every log record and on the
   * artifact immediately before it is written.
   *
   * Keys are redacted as well as values: a field literally named `password`
   * gets its value replaced regardless of what the value looks like.
   */
  value<T>(input: T, depth = 0): T {
    if (depth > 12) return input;
    if (input == null) return input;

    if (typeof input === 'string') return this.text(input) as unknown as T;

    if (typeof input === 'number') {
      // Numbers need checking too, and it is easy to miss.
      //
      // An extracted balance is registered as the string it was scraped from
      // ("$55,023.10") but is *stored* as the coerced number 55023.1. Passing
      // numbers through untouched let a regulated value land in a saved result
      // document while every string form of it was correctly scrubbed —
      // caught only because the evidence was grepped for it afterwards.
      const asText = String(input);
      if (this.secrets.has(asText)) {
        this.bump('runtime_secret');
        return '[REDACTED:SECRET]' as unknown as T;
      }
      return input;
    }

    if (typeof input === 'boolean') return input;

    if (Array.isArray(input)) {
      return input.map((v) => this.value(v, depth + 1)) as unknown as T;
    }

    if (typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (SENSITIVE_KEY.test(k) && typeof v === 'string' && v.length > 0) {
          out[k] = '[REDACTED:FIELD]';
          this.bump(`field:${k}`);
        } else {
          out[k] = this.value(v, depth + 1);
        }
      }
      return out as unknown as T;
    }

    return input;
  }

  private bump(name: string): void {
    this.stats.hits[name] = (this.stats.hits[name] ?? 0) + 1;
  }
}

const SENSITIVE_KEY =
  /^(password|passwd|pwd|secret|token|api[_-]?key|authorization|auth|ssn|social|tax_?id|pin|cvv|card_?number|pan)$/i;

export const DEFAULT_PATTERNS: RedactionPattern[] = [
  { name: 'ssn', regex: '\\b\\d{3}-\\d{2}-\\d{4}\\b', replacement: '[REDACTED:SSN]' },
  { name: 'anthropic_key', regex: 'sk-ant-[A-Za-z0-9_\\-]{8,}', replacement: '[REDACTED:CREDENTIAL]' },
];

/**
 * Register the regulated values visible on a screen, before anything is
 * written about that screen.
 *
 * The redactor has two mechanisms and they cover different things. Patterns
 * catch values with a recognisable shape — an SSN, a card number, an email.
 * Runtime registration catches values with no shape at all, and it is the only
 * thing that can: a member's name and street address look exactly like prose.
 *
 * Until now, registration happened when a value was *extracted*, because an
 * artifact output classified `pii` declares it regulated. That leaves two
 * holes, and both were live:
 *
 *   - A failing replay writes a debug dump of the screen without extracting
 *     anything, so it persisted a member's name that a successful run scrubbed.
 *     Failures are when a dump is most wanted and most dangerous.
 *   - Discovery has no artifact yet, so nothing has declared anything, and the
 *     trace is written from screens full of member data.
 *
 * The fix is structural and is what policy.yaml's `sensitiveNamePatterns`
 * already describes: a value whose LABEL says it is regulated is regulated,
 * whatever it looks like. The label is on the screen; use it.
 *
 * Called after every observation, in both loops, so registration precedes the
 * first write rather than trailing it.
 */
export function registerRegulatedValues(
  nodes: ReadonlyArray<{
    role: string;
    label?: string;
    value?: string;
    columnHeader?: string;
  }>,
  isRegulatedLabel: (label: string) => boolean,
  redactor: Redactor,
): number {
  let registered = 0;

  /**
   * A column header is a label, not a value.
   *
   * In a header row each cell's derived label is the PREVIOUS header cell, so
   * the cell reading "Status" is labelled "Balance" and matches the regulated
   * pattern. Registering it scrubs the word "Status" out of every log line in
   * the run — which is how `shareStatus` came back as `share[REDACTED]`.
   *
   * Any text that serves as a column header somewhere in this snapshot is
   * therefore excluded: it is part of the page's furniture, not member data.
   */
  const headerTexts = new Set(
    nodes.map((n) => n.columnHeader?.trim()).filter((h): h is string => !!h),
  );

  for (const n of nodes) {
    const text = (n.value ?? '').trim();
    // Short values are skipped: a two-character cell is as likely to be a
    // status flag as a name, and registering it would scrub half the log.
    if (text.length < 4) continue;

    // Either axis may carry the label — a form field is labelled by its
    // neighbouring cell, a grid cell by its column header.
    if (headerTexts.has(text)) continue;

    const labels = [n.label, n.columnHeader].filter((l): l is string => !!l);
    if (!labels.some(isRegulatedLabel)) continue;

    redactor.registerSecret(text);
    registered++;

    // The audit caught a balance registered as the string it was scraped from
    // ("$55,023.10") but stored as the coerced number 55023.1, which passed
    // through untouched. Register the numeric forms too.
    const numeric = text.replace(/[$,]/g, '');
    if (numeric !== text && /^-?\d+(\.\d+)?$/.test(numeric)) {
      redactor.registerSecret(numeric);
      redactor.registerSecret(String(Number(numeric)));
      registered += 2;
    }
  }

  return registered;
}
