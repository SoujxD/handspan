/**
 * Capability store and the agent-facing catalog view.
 *
 * Storage is one JSON file per capability on disk. That is a deliberate choice
 * rather than a shortcut: an artifact is a *reviewable* object, and a file in
 * git gets code review, diffs, blame, and rollback for free. A database row
 * would need all of that rebuilt before it was as good.
 *
 * `toToolDefinition` is the payoff of the schema work. Because the artifact
 * already carries typed inputs, typed outputs, and a description written for a
 * caller, projecting it into a function-calling tool definition is mechanical.
 * An agent discovers capabilities by name and invokes them with typed args,
 * without knowing anything about browsers.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Capability, parseCapability } from '../types/artifact.js';
import { hashCapability } from '../agent/compiler.js';

export class CapabilityStore {
  constructor(private readonly dir: string) {}

  private fileFor(id: string, version: number): string {
    return join(this.dir, `${id}.v${version}.json`);
  }

  save(cap: Capability): string {
    const path = this.fileFor(cap.id, cap.version);
    writeFileSync(path, `${JSON.stringify(cap, null, 2)}\n`, 'utf8');
    return path;
  }

  /**
   * Load and re-validate.
   *
   * Both checks matter. `parseCapability` re-runs the structural invariants, so
   * a hand-edited file cannot smuggle in a retry on an irreversible step. The
   * hash check is not security — it is a *review* signal: if the artifact
   * changed since it was recorded, an approval granted before that edit no
   * longer means anything, and the operator deserves to be told.
   */
  load(id: string, version?: number): Capability {
    const path = version ? this.fileFor(id, version) : this.latestPathFor(id);
    if (!path || !existsSync(path)) {
      throw new Error(`No capability "${id}"${version ? ` v${version}` : ''} in ${this.dir}.`);
    }
    const cap = parseCapability(JSON.parse(readFileSync(path, 'utf8')));

    const recorded = cap.provenance.contentHash;
    if (recorded) {
      const actual = hashCapability(cap);
      if (actual !== recorded) {
        // eslint-disable-next-line no-console
        console.warn(
          `  ! Content hash mismatch for ${cap.id} v${cap.version}: recorded ${recorded}, actual ${actual}.\n` +
            `    The artifact has been edited since it was recorded. Its approval state no longer reflects a review.`,
        );
      }
    }
    return cap;
  }

  list(): Capability[] {
    if (!existsSync(this.dir)) return [];
    const out: Capability[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(parseCapability(JSON.parse(readFileSync(join(this.dir, f), 'utf8'))));
      } catch {
        // A malformed artifact must not take down the whole catalog; it simply
        // is not offered. `handspan capabilities` reports the count so a
        // missing one is noticeable.
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id) || b.version - a.version);
  }

  /** Newest version of each id. */
  listLatest(): Capability[] {
    const byId = new Map<string, Capability>();
    for (const c of this.list()) {
      const prev = byId.get(c.id);
      if (!prev || c.version > prev.version) byId.set(c.id, c);
    }
    return [...byId.values()];
  }

  private latestPathFor(id: string): string | undefined {
    const versions = this.list()
      .filter((c) => c.id === id)
      .sort((a, b) => b.version - a.version);
    const top = versions[0];
    return top ? this.fileFor(top.id, top.version) : undefined;
  }

  /** Record a replay outcome against the capability's stability score. */
  recordRun(cap: Capability, success: boolean): void {
    cap.governance.stability.runs += 1;
    if (success) cap.governance.stability.successes += 1;
    cap.provenance.contentHash = hashCapability(cap);
    this.save(cap);
  }
}

/** JSON-Schema tool definition, the shape a function-calling agent expects. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  /** Not part of the calling contract, but what a router needs to decide. */
  handspan: {
    capabilityId: string;
    version: number;
    approval: string;
    maxRisk: string;
    requiresConfirmation: boolean;
    tenants: string[];
    returns: Array<{ name: string; type: string; description: string; sensitivity: string }>;
    outcomes: Array<{ code: string; title: string; classification: string }>;
    stability: { runs: number; successes: number };
  };
}

export function toToolDefinition(cap: Capability): ToolDefinition {
  const properties: Record<string, unknown> = {
    tenantId: {
      type: 'string',
      description: 'Institution to run against.',
      enum: cap.tenants.map((t) => t.tenantId),
    },
  };
  const required: string[] = ['tenantId'];

  for (const p of cap.inputs) {
    properties[p.name] = {
      type: p.type === 'money' || p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string',
      description:
        p.description +
        (p.sensitivity === 'secret' || p.sensitivity === 'pii'
          ? ` (${p.sensitivity}: never logged or persisted)`
          : ''),
      ...(p.enumValues?.length ? { enum: p.enumValues } : {}),
    };
    if (p.required) required.push(p.name);
  }

  if (cap.policy.requiresConfirmation) {
    properties['confirm'] = {
      type: 'string',
      description:
        `This capability commits state. To run it unattended you must pass confirm="${cap.id}", ` +
        `which is an explicit acknowledgement that the change is intended.`,
    };
  }

  // The description an agent reads to decide whether to call this. Outcomes are
  // included because a caller that does not know "member_not_found" is possible
  // will write a broken error path.
  const outcomeLines = cap.outcomes
    .filter((o) => o.classification === 'business')
    .map((o) => `  - "${o.code}": ${o.title}`)
    .join('\n');

  const description =
    `${cap.description}\n\n` +
    `Returns: ${cap.outputs.map((o) => `${o.name} (${o.type})`).join(', ') || 'no data outputs'}.\n` +
    (outcomeLines
      ? `May instead return one of these business outcomes, which are valid answers and not errors:\n${outcomeLines}\n`
      : '') +
    `Risk: ${cap.policy.maxRisk}. Approval: ${cap.governance.approval}.`;

  return {
    name: cap.id,
    description,
    input_schema: { type: 'object', properties, required },
    handspan: {
      capabilityId: cap.id,
      version: cap.version,
      approval: cap.governance.approval,
      maxRisk: cap.policy.maxRisk,
      requiresConfirmation: cap.policy.requiresConfirmation,
      tenants: cap.tenants.map((t) => t.tenantId),
      returns: cap.outputs.map((o) => ({
        name: o.name,
        type: o.type,
        description: o.description,
        sensitivity: o.sensitivity,
      })),
      outcomes: cap.outcomes.map((o) => ({
        code: o.code,
        title: o.title,
        classification: o.classification,
      })),
      stability: cap.governance.stability,
    },
  };
}
