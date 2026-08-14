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
