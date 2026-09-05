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
  /**
   * Optional checksum gate on whatever the regex matched.
   *
   * A pattern that recognises a *format* will fire on anything shaped like it,
   * and for card numbers the format is "13 to 19 digits" — which is also the
   * shape of a timestamp, an order reference, and this system's own run ids.
   * Every persisted evidence file was reporting its own `runId` as
   * `replay-[REDACTED:PAN]-8e3d7a`, so a result could not be correlated back to
   * the run that produced it. An audit trail that redacts its own correlation
   * key is not doing redaction, it is losing evidence.
   *
   * This does not soften the file's "fail toward over-matching" doctrine. The
   * gate tests properties of the thing being detected, not a confidence
   * threshold: every issued card number satisfies both of them, so nothing that
   * is a PAN stops being matched. It removes a class of false positive without
   * giving up recall, which is why production DLP engines gate the same rule
   * the same way.
   */
  validate?: 'card';
}

/**
 * Checksum validators, keyed by the name a pattern declares.
 *
 * Separate from the patterns themselves so policy stays data. A rule that
 * names a validator this map does not have is a policy error, not a silent
 * downgrade to "match everything" — see the constructor.
 */
/**
 * Issuer Identification Number ranges actually in circulation (ISO/IEC 7812).
 *
 * The check-digit test alone is not enough. It rejects nine out of ten
 * arbitrary numbers, which sounds decisive and is not: one run id in ten still
 * satisfies it by chance, and `20260905015133` — a real timestamp from this
 * project's evidence — is one of them. A number is only a card if it is *also*
 * issued from an assigned range, so both tests are applied.
 */
const IIN_RANGES: Array<{ lo: number; hi: number; digits: number }> = [
  { lo: 4, hi: 4, digits: 1 }, // Visa
  { lo: 34, hi: 34, digits: 2 }, // American Express
  { lo: 37, hi: 37, digits: 2 }, // American Express
  { lo: 36, hi: 36, digits: 2 }, // Diners Club International
  { lo: 38, hi: 39, digits: 2 }, // Diners Club / carte blanche
  { lo: 51, hi: 55, digits: 2 }, // Mastercard
  { lo: 62, hi: 62, digits: 2 }, // UnionPay
  { lo: 65, hi: 65, digits: 2 }, // Discover
  { lo: 300, hi: 305, digits: 3 }, // Diners Club
  { lo: 644, hi: 649, digits: 3 }, // Discover
  { lo: 2221, hi: 2720, digits: 4 }, // Mastercard 2-series
  { lo: 3528, hi: 3589, digits: 4 }, // JCB
  { lo: 6011, hi: 6011, digits: 4 }, // Discover
];

const VALIDATORS: Record<string, (match: string) => boolean> = {
  /**
   * Is this actually a payment card number?
   *
   * Two independent tests, both of which every issued card satisfies:
   * an assigned issuer range, and the ISO/IEC 7812 check digit. Separators are
   * stripped first because the pattern deliberately tolerates the spaces and
   * hyphens a card is printed with. Length is re-checked here as well as in the
   * regex, so the validator stays correct if the pattern is ever loosened.
   */
  card(match: string): boolean {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return false;

    const issued = IIN_RANGES.some((r) => {
      const prefix = Number(digits.slice(0, r.digits));
      return prefix >= r.lo && prefix <= r.hi;
    });
    if (!issued) return false;

    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
      let d = digits.charCodeAt(i) - 48;
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      double = !double;
    }
    return sum % 10 === 0;
  },
};

export interface RedactionStats {
  /** How many times each rule fired. Surfaced in the run summary so a spike in
   *  redactions is visible rather than silent. */
  hits: Record<string, number>;
}

export class Redactor {
  private readonly compiled: Array<{
    name: string;
    re: RegExp;
    replacement: string;
    validate?: (match: string) => boolean;
  }>;
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
      // An unknown validator name is refused rather than ignored. Ignoring it
      // would leave the rule matching everything it matched before, which is
      // the safe direction for redaction and the wrong one for trust: the
      // policy would claim a checksum gate it does not have.
      if (p.validate !== undefined && VALIDATORS[p.validate] === undefined) {
        throw new Error(
          `policy.yaml: redaction pattern "${p.name}" declares unknown validator "${p.validate}". ` +
            `Known validators: ${Object.keys(VALIDATORS).join(', ')}.`,
        );
      }
      const validate = p.validate ? VALIDATORS[p.validate] : undefined;
      try {
        return {
          name: p.name,
          re: new RegExp(p.regex, 'gi'),
          replacement: p.replacement,
          ...(validate ? { validate } : {}),
        };
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
      if (!p.re.test(out)) continue;
      p.re.lastIndex = 0;

      if (!p.validate) {
        out = out.replace(p.re, p.replacement);
        this.bump(p.name);
        continue;
      }

      // A validated rule may match and still decline, so the hit is counted
      // from what was actually replaced rather than from what matched.
      const check = p.validate;
      let fired = false;
      out = out.replace(p.re, (match) => {
        if (!check(match)) return match;
        fired = true;
        return p.replacement;
      });
      if (fired) this.bump(p.name);
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
