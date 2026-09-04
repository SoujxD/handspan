/**
 * Run history, read from the evidence directory.
 *
 * There is deliberately no run database. Every run already writes a complete,
 * redacted record to `/evidence` — the step trace, the result contract, the
 * snapshots — because that is the audit artifact a reviewer needs anyway. A
 * second store would be a copy of it that can disagree with it, and the copy
 * is the one that would end up on the dashboard.
 *
 * So this indexes what is on disk. It is the same source of truth a person
 * gets by opening the folder, which is the property that matters when someone
 * asks "is the dashboard telling me the truth".
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ReplayResult } from '../types/result.js';

export type RunKind = 'discovery' | 'replay' | 'recon' | 'other';

export interface RunSummary {
  runId: string;
  kind: RunKind;
  startedAt: string;
  /** success | outcome | escalated | failure for a replay; undefined mid-run. */
  status?: ReplayResult['status'];
  capabilityId?: string;
  capabilityVersion?: number;
  tenantId?: string;
  durationMs?: number;
  llmCalls?: number;
  steps?: number;
  /** Business outcome code or failure kind, for the one-line summary. */
  detail?: string;
  fileCount: number;
}

export interface RunDetail extends RunSummary {
  result?: ReplayResult;
  /** Parsed run.jsonl, newest last. */
  log: Array<Record<string, unknown>>;
  evidence: Array<{ name: string; bytes: number }>;
}

function kindOf(runId: string): RunKind {
  if (runId.startsWith('disc-')) return 'discovery';
  if (runId.startsWith('replay-')) return 'replay';
  if (runId.startsWith('recon-')) return 'recon';
  return 'other';
}

/**
 * Run ids carry their own timestamp (`replay-20260904-161940-02e2d7`), so the
 * listing does not depend on filesystem mtimes, which change when a directory
 * is copied or restored.
 */
function startedAtOf(runId: string): string {
  const m = /(\d{8})-(\d{6})/.exec(runId);
  if (!m) return '';
  const [, d, t] = m as unknown as [string, string, string];
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function detailOf(result: ReplayResult | undefined): string | undefined {
  if (!result) return undefined;
  switch (result.status) {
    case 'outcome':
      return result.outcome;
    case 'failure':
      return result.failure.kind;
    case 'escalated':
      return result.reason;
    default:
      return undefined;
  }
}

export function listRuns(evidenceDir: string, limit = 200): RunSummary[] {
  if (!existsSync(evidenceDir)) return [];

  const out: RunSummary[] = [];
  for (const entry of readdirSync(evidenceDir)) {
    const dir = join(evidenceDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const kind = kindOf(entry);
    if (kind === 'other') continue;

    const files = readdirSync(dir);
    const result = readJson<ReplayResult>(join(dir, 'result.json'));
    const trace = result
      ? undefined
      : readJson<{ actions?: unknown[]; llmCalls?: number; goal?: string; tenantId?: string }>(
          join(dir, 'discovery-trace.json'),
        );

    out.push({
      runId: entry,
      kind,
      startedAt: startedAtOf(entry),
      fileCount: files.length,
      ...(result
        ? {
            status: result.status,
            capabilityId: result.meta.capabilityId,
            capabilityVersion: result.meta.capabilityVersion,
            tenantId: result.meta.tenantId,
            durationMs: result.meta.durationMs,
            llmCalls: result.meta.llmCalls,
            steps: result.trace?.length ?? 0,
            ...(detailOf(result) ? { detail: detailOf(result)! } : {}),
          }
        : {}),
      ...(trace
        ? {
            llmCalls: trace.llmCalls ?? 0,
            steps: trace.actions?.length ?? 0,
            ...(trace.tenantId ? { tenantId: trace.tenantId } : {}),
            ...(trace.goal ? { detail: trace.goal.slice(0, 120) } : {}),
          }
        : {}),
    });
  }

  return out.sort((a, b) => b.runId.localeCompare(a.runId)).slice(0, limit);
}

export function readRun(evidenceDir: string, runId: string): RunDetail | undefined {
  // The run id comes off a URL. Anything with a path separator in it is not a
  // run id, it is an attempt to read somewhere else.
  if (!/^[a-z]+-\d{8}-\d{6}(-[0-9a-f]{6})?$/.test(runId)) return undefined;

  const dir = join(evidenceDir, runId);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined;

  const files = readdirSync(dir);
  const result = readJson<ReplayResult>(join(dir, 'result.json'));

  const log: Array<Record<string, unknown>> = [];
  const logPath = join(dir, 'run.jsonl');
  if (existsSync(logPath)) {
    for (const line of readFileSync(logPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        log.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* a truncated final line means the run is still going */
      }
    }
  }

  const summary = listRuns(evidenceDir).find((r) => r.runId === runId);

  return {
    ...(summary ?? { runId, kind: kindOf(runId), startedAt: startedAtOf(runId), fileCount: files.length }),
    ...(result ? { result } : {}),
    log,
    evidence: files.map((f) => ({ name: f, bytes: statSync(join(dir, f)).size })),
  };
}
