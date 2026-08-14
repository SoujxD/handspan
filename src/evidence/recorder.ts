/**
 * Evidence.
 *
 * Two obligations, and they pull against each other:
 *   - Produce enough to debug a run that went wrong days later.
 *   - Persist no regulated data.
 *
 * They are reconciled by making the redactor a *constructor dependency* of the
 * recorder rather than something callers remember to apply. There is no method
 * on this class that writes unredacted bytes, so "we forgot to redact that one
 * log line" is not a reachable state.
 *
 * Screenshots are the exception that proves the rule: text redaction cannot
 * help with pixels, so sensitive regions are masked in the browser before
 * capture (see PlaywrightSurface.screenshot) and the recorder is handed the
 * already-safe buffer.
 *
 * Format is JSONL: one JSON object per line, append-only. Greppable by a human
 * at 2am and parseable by a log pipeline, without needing either.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceRef } from '../types/result.js';
import type { Redactor } from '../safety/redaction.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  ts: string;
  level: LogLevel;
  runId: string;
  event: string;
  [key: string]: unknown;
}

export class EvidenceRecorder {
  readonly dir: string;
  private readonly logPath: string;
  private readonly refs: EvidenceRef[] = [];
  private seq = 0;

  constructor(
    readonly runId: string,
    baseDir: string,
    private readonly redactor: Redactor,
    private readonly echoToConsole = true,
  ) {
    this.dir = join(baseDir, runId);
    mkdirSync(this.dir, { recursive: true });
    this.logPath = join(this.dir, 'run.jsonl');
    this.refs.push({ kind: 'log', path: this.rel(this.logPath), capturedAt: new Date().toISOString() });
  }

  get evidence(): EvidenceRef[] {
    return [...this.refs];
  }

  /**
   * Structured log line. Every field passes through the redactor, including
   * nested objects — a page-text excerpt in `observed` is scrubbed the same way
   * a top-level field is.
   */
  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    const record: LogRecord = this.redactor.value({
      ts: new Date().toISOString(),
      level,
      runId: this.runId,
      event,
      ...fields,
    });
    appendFileSync(this.logPath, `${JSON.stringify(record)}\n`, 'utf8');

    if (this.echoToConsole) {
      const tag = level === 'error' ? 'ERR ' : level === 'warn' ? 'WARN' : level === 'debug' ? 'dbg ' : 'info';
      const extras = Object.entries(fields)
        .filter(([k]) => !['ts', 'level', 'runId'].includes(k))
        .slice(0, 4)
        .map(([k, v]) => `${k}=${short(this.redactor.value(v))}`)
        .join(' ');
      // eslint-disable-next-line no-console
      console.log(`  [${tag}] ${event}${extras ? '  ' + extras : ''}`);
    }
  }

  info(event: string, fields?: Record<string, unknown>): void {
    this.log('info', event, fields);
  }
  warn(event: string, fields?: Record<string, unknown>): void {
    this.log('warn', event, fields);
  }
  error(event: string, fields?: Record<string, unknown>): void {
    this.log('error', event, fields);
  }
  debug(event: string, fields?: Record<string, unknown>): void {
    this.log('debug', event, fields);
  }

  /** Buffer must already be masked; see the class comment. */
  saveScreenshot(label: string, buf: Buffer): EvidenceRef {
    const name = `${String(++this.seq).padStart(3, '0')}-${slug(label)}.png`;
    const path = join(this.dir, name);
    writeFileSync(path, buf);
    const ref: EvidenceRef = { kind: 'screenshot', path: this.rel(path), capturedAt: new Date().toISOString() };
    this.refs.push(ref);
    return ref;
  }

  saveDom(label: string, html: string): EvidenceRef {
    const name = `${String(++this.seq).padStart(3, '0')}-${slug(label)}.html`;
    const path = join(this.dir, name);
    writeFileSync(path, this.redactor.text(html), 'utf8');
    const ref: EvidenceRef = { kind: 'dom_snapshot', path: this.rel(path), capturedAt: new Date().toISOString() };
    this.refs.push(ref);
    return ref;
  }

  /**
   * The normalized snapshot the engine actually reasoned about.
   *
   * More useful than raw HTML for the specific question "why did the resolver
   * not find that button" — it shows exactly the role/label/container triple
   * the scorer saw.
   */
  saveSnapshot(label: string, snapshot: unknown): EvidenceRef {
    const name = `${String(++this.seq).padStart(3, '0')}-${slug(label)}.a11y.json`;
    const path = join(this.dir, name);
    writeFileSync(path, JSON.stringify(this.redactor.value(snapshot), null, 2), 'utf8');
    const ref: EvidenceRef = { kind: 'a11y_snapshot', path: this.rel(path), capturedAt: new Date().toISOString() };
    this.refs.push(ref);
    return ref;
  }

  /** Arbitrary JSON side-car (result document, intervention record, ...). */
  saveJson(name: string, data: unknown): string {
    const path = join(this.dir, name.endsWith('.json') ? name : `${name}.json`);
    writeFileSync(path, JSON.stringify(this.redactor.value(data), null, 2), 'utf8');
    return this.rel(path);
  }

  private rel(p: string): string {
    return p.replace(/\\/g, '/');
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'item';
}

function short(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
