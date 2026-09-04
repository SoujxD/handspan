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
import { type Capability, parseCapability, validateCapability } from '../types/artifact.js';
import type { ReplayResult } from '../types/result.js';
import { hashCapability } from '../agent/compiler.js';

export class CapabilityStore {
  constructor(private readonly dir: string) {}

  private fileFor(id: string, version: number): string {
    return join(this.dir, `${id}.v${version}.json`);
  }

  /**
   * Write an artifact, refusing to write one that would not load back.
   *
   * The compiler validates what the model produces, but every reviewer command
   * — declare-outcome, reclassify-outcome, assert-checkpoint, revise-input,
   * approve — writes through here, and none of them validated.
   *
   * That was not theoretical. Moving an outcome from `recoverable` to
   * `escalate` left its now-meaningless recovery action attached; the file was
   * written happily, `list()` then dropped it as unparseable, and production
   * silently kept running the previous version. The command reported success.
   * A reviewer's change having no effect is worse than a reviewer's change
   * being rejected, because nothing anywhere says so.
   */
  save(cap: Capability): string {
    const problems = validateCapability(cap);
    if (problems.length) {
      throw new Error(
        `Refusing to write ${cap.id} v${cap.version} — it would not load back:\n` +
          problems.map((p) => `  - ${p}`).join('\n'),
      );
    }
    const path = this.fileFor(cap.id, cap.version);
    writeFileSync(path, `${JSON.stringify(cap, null, 2)}\n`, 'utf8');
    return path;
  }

  /**
   * The next free version number for an id.
   *
   * The compiler has no idea whether this flow has been recorded before, so it
   * always emits `version: 1` — which quietly overwrote an existing v1, taking
   * a reviewed artifact with it. Versions are supposed to be immutable and
   * additive: a re-recording is a new version to compare against the old one,
   * never a replacement for it. Asking the store, which is the thing that knows
   * what exists, is the fix.
   */
  nextVersion(id: string): number {
    const existing = this.list().filter((c) => c.id === id);
    return existing.reduce((max, c) => Math.max(max, c.version), 0) + 1;
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

  /**
   * The version a REVIEWER edits: the newest one, approved or not.
   *
   * `load` deliberately prefers the newest *approved* version, because that is
   * what should run. Applying that same rule to an edit is wrong, and was: two
   * successive reviewer commands each branched off the approved v2 and wrote
   * v3, so the second silently discarded the first. The fix that had been
   * applied was simply gone, with no error anywhere — the edit reported
   * success and the artifact reported the old value.
   *
   * Running wants the reviewed version. Editing wants the latest. They are
   * different questions and now have different methods.
   */
  loadForEdit(id: string): Capability {
    const versions = this.list()
      .filter((c) => c.id === id)
      .sort((a, b) => b.version - a.version);
    const newest = versions[0];
    if (!newest) throw new Error(`No capability "${id}" in ${this.dir}.`);
    return this.load(id, newest.version);
  }

  /** Artifacts on disk that failed validation, with the reason. */
  readonly rejected: Array<{ file: string; reason: string }> = [];

  list(): Capability[] {
    if (!existsSync(this.dir)) return [];
    const out: Capability[] = [];
    this.rejected.length = 0;

    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(parseCapability(JSON.parse(readFileSync(join(this.dir, f), 'utf8'))));
      } catch (e) {
        // A malformed artifact must not take down the whole catalog — but it
        // must not vanish silently either. Swallowing this turned "your
        // capability has an invalid outcome detector" into "no capabilities
        // yet", which sends you looking in entirely the wrong place.
        this.rejected.push({ file: f, reason: (e as Error).message });
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id) || b.version - a.version);
  }

  /**
   * The version of each capability that callers should see: newest approved,
   * falling back to newest overall.
   *
   * Same rule as `load`, and it has to be, or the catalog advertises a tool
   * definition for a draft that `load` will then refuse to run — an agent
   * reading inputs off one version and invoking another. The two views of
   * "current" must agree.
   */
  listLatest(): Capability[] {
    const byId = new Map<string, Capability>();

    for (const c of this.list()) {
      const prev = byId.get(c.id);
      if (!prev) {
        byId.set(c.id, c);
        continue;
      }
      const better =
        approvalRank(c) !== approvalRank(prev)
          ? approvalRank(c) > approvalRank(prev)
          : c.version > prev.version;
      if (better) byId.set(c.id, c);
    }
    return [...byId.values()];
  }

  /**
   * Which version an unpinned load gets: the newest **approved** one.
   *
   * "Newest" is the obvious rule and it is wrong. Once anything can write a new
   * version without a human — a re-recording, a repair proposal — newest-wins
   * means an unreviewed draft silently becomes what production runs, which
   * inverts the entire approval model. A draft has to be something you opt
   * into.
   *
   * The fallback to newest-overall exists for the state before any review has
   * happened: a freshly discovered capability is all drafts, and refusing to
   * load it at all would make the tool unusable between recording and review.
   * Once one version is approved, drafts stop being reachable by accident.
   */
  private latestPathFor(id: string): string | undefined {
    const versions = this.list()
      .filter((c) => c.id === id)
      .sort((a, b) => b.version - a.version);

    const approved = versions.find((c) => c.governance.approval === 'approved');
    const chosen = approved ?? versions[0];
    if (!chosen) return undefined;

    if (approved && versions[0] && versions[0].version > approved.version) {
      // Say so. A newer draft sitting unreviewed is a fact the operator wants,
      // and silence here is how a repair proposal gets forgotten for a month.
      // eslint-disable-next-line no-console
      console.log(
        `  Using ${id} v${approved.version} (approved). v${versions[0].version} exists but is ` +
          `${versions[0].governance.approval} — pin it with --capability-version to try it.`,
      );
    }
    return this.fileFor(chosen.id, chosen.version);
  }

  /**
   * Record a replay outcome against the capability's stability score.
   *
   * Only runs that actually exercised the capability count. A run rejected at
   * pre-flight — missing a required input, a malformed artifact — never touched
   * the surface and says nothing about whether the capability works; counting
   * it lets a caller's typo lower a capability's reliability score, and
   * eventually block its approval. That is a scoring bug with real
   * consequences, and it was live: two mistyped commands took a healthy
   * capability to 1/2.
   *
   * Returns whether the run was counted, so callers can say so.
   */
  recordRun(cap: Capability, result: ReplayResult): boolean {
    if (!countsTowardStability(result)) return false;

    cap.governance.stability.runs += 1;
    if (result.status === 'success' || result.status === 'outcome') {
      cap.governance.stability.successes += 1;
    }
    cap.provenance.contentHash = hashCapability(cap);
    this.save(cap);
    return true;
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
      // Examples help a calling model get the shape right first time — a member
      // number that looks like "12345" is a different thing from one that looks
      // like "MBR-000-12345". Never for a secret: an example credential in a
      // published catalog is a credential in a published catalog.
      ...(p.example !== undefined && p.sensitivity !== 'secret' ? { examples: [p.example] } : {}),
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

  /**
   * Lead with what this capability DOES.
   *
   * Discovery writes a description that narrates the flow, and every flow on a
   * target like this one starts the same way — "signs on to the servicing
   * console, looks up a member by member number, …" — so the first ninety
   * characters are identical across the whole catalog and the distinguishing
   * clause is buried.
   *
   * A tool description is the routing surface: it is the only thing a calling
   * agent chooses with. Asked to move money, the router picked the balance
   * lookup, and nothing near the front of the text told it otherwise. The
   * capability's own short name is already distinctive, so it goes first —
   * cheaper and far more reliable than re-recording seven artifacts hoping for
   * better prose.
   */
  const description =
    `${cap.name}. ${cap.description}\n\n` +
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

/**
 * Did this run tell us anything about whether the capability works?
 *
 * A pre-flight rejection is a statement about the *caller*, and an invalid
 * artifact is a statement about the *file*. Neither is evidence about the
 * flow, so neither belongs in a reliability score that gates approval.
 * Everything that reached the surface counts — including escalations and hard
 * failures, which are exactly the outcomes a stability figure should reflect.
 */
export function countsTowardStability(result: ReplayResult): boolean {
  if (result.status !== 'failure') return true;
  return result.failure.kind !== 'invalid_input' && result.failure.kind !== 'artifact_invalid';
}

/** Approved beats anything else; among equals, the newest version wins. */
function approvalRank(cap: Capability): number {
  return cap.governance.approval === 'approved' ? 1 : 0;
}
