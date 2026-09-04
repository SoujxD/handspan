/**
 * Process configuration and wiring.
 *
 * One place that knows about the filesystem, the environment, and how the
 * safety objects are constructed — so that every entry point (discover, replay,
 * catalog) gets an identically-configured policy engine and redactor. A replay
 * that ran under a laxer policy than the recording is not a replay of the same
 * capability.
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PolicyEngine } from './safety/policy.js';
import { Redactor, registerRegulatedValues } from './safety/redaction.js';
import type { SurfaceSnapshot } from './types/surface.js';

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(here, '..');

export const PATHS = {
  policy: join(PROJECT_ROOT, 'policy.yaml'),
  institutions: join(PROJECT_ROOT, 'institutions.json'),
  artifacts: join(PROJECT_ROOT, 'artifacts'),
  evidence: join(PROJECT_ROOT, 'evidence'),
};

for (const dir of [PATHS.artifacts, PATHS.evidence]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export interface RuntimeConfig {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  targetAppBase: string;
  operatorPort: number;
  catalogPort: number;
  headless: boolean;
}

export function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    model: process.env['HANDSPAN_MODEL'] ?? 'claude-opus-5',
    effort: (process.env['HANDSPAN_EFFORT'] as RuntimeConfig['effort']) ?? 'high',
    targetAppBase: `http://localhost:${process.env['TARGET_APP_PORT'] ?? 4300}`,
    operatorPort: Number(process.env['OPERATOR_PORT'] ?? 4400),
    catalogPort: Number(process.env['CATALOG_PORT'] ?? 4500),
    headless: process.env['HANDSPAN_HEADLESS'] === '1',
    ...overrides,
  };
}

export function loadPolicy(): PolicyEngine {
  return PolicyEngine.load(PATHS.policy);
}

/**
 * Build the redactor from policy, then seed it with the credentials this
 * process knows about. Registering the demo password here is the reason a
 * password can never appear in a log even though no regex matches it.
 */
export function buildRedactor(policy: PolicyEngine): Redactor {
  const r = new Redactor(policy.file.redaction.patterns, policy.file.redaction.scrubRuntimeSecrets);
  for (const key of ['ANTHROPIC_API_KEY', 'DEMO_PASSWORD']) {
    const v = process.env[key];
    if (v) r.registerSecret(v);
  }
  return r;
}

/**
 * The observation hook every surface is launched with.
 *
 * Registers a screen's regulated values for scrubbing before the caller can
 * write anything about that screen. Built here for the same reason the policy
 * engine is: every entry point must get the identical one, or the guarantee
 * holds in `replay` and quietly does not in `discover`.
 */
export function observationRedactionHook(
  policy: PolicyEngine,
  redactor: Redactor,
): (snapshot: SurfaceSnapshot) => void {
  const isRegulated = (label: string): boolean =>
    policy.classify({ kind: 'type', fieldLabel: label }) === 'sensitive';
  return (snapshot) => {
    registerRegulatedValues(snapshot.nodes, isRegulated, redactor);
  };
}

export function newRunId(prefix: 'disc' | 'replay' | 'verify' | 'drift' | 'repair'): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${prefix}-${stamp}-${randomUUID().slice(0, 6)}`;
}

/**
 * An institution this system may drive.
 *
 * `product` names the vendor build rather than the institution, because a
 * recording is product-scoped: two credit unions running the same software
 * share one artifact and differ only by a tenant binding.
 */
export interface Institution {
  tenantId: string;
  displayName: string;
  /** Absolute URL, or a path resolved against the local fixture app. */
  baseUrl: string;
  product: string;
  productVersion: string;
  /** One true sentence about what this deployment is, for the model's
   *  environment header. See DiscoveryDeps.environmentNote. */
  environmentNote?: string;
}

/**
 * Load the institution registry.
 *
 * This used to come from `target-app/data.ts` — the fixture application's own
 * module — which meant the list of institutions the system could drive was a
 * property of the mock. An institution that was not part of the fixture could
 * not be named at all. Reading it from a data file instead is what makes
 * onboarding a new deployment a configuration change.
 */
export function loadInstitutions(): Record<string, Institution> {
  const raw = JSON.parse(readFileSync(PATHS.institutions, 'utf8')) as Record<string, unknown>;
  const base = runtimeConfig().targetAppBase;
  const out: Record<string, Institution> = {};
  for (const [tenantId, value] of Object.entries(raw)) {
    if (tenantId.startsWith('$') || typeof value !== 'object' || value === null) continue;
    const v = value as Omit<Institution, 'tenantId'>;
    out[tenantId] = {
      tenantId,
      displayName: v.displayName,
      baseUrl: v.baseUrl.startsWith('/') ? `${base}${v.baseUrl}` : v.baseUrl,
      product: v.product,
      productVersion: v.productVersion,
      ...(v.environmentNote ? { environmentNote: v.environmentNote } : {}),
    };
  }
  return out;
}

export function requireInstitution(tenantId: string): Institution {
  const all = loadInstitutions();
  const hit = all[tenantId];
  if (!hit) {
    throw new Error(
      `Unknown institution "${tenantId}". Known: ${Object.keys(all).join(', ')}.\n` +
        `Add it to institutions.json, and its origin to policy.yaml.`,
    );
  }
  return hit;
}

/**
 * The one place a model client is constructed.
 *
 * An identity-linked API key — one issued against a person rather than a bare
 * organisation key — is rejected with a 400 unless every request names the
 * workspace it acts in. That is an account-shape difference, not a target
 * difference: the same code works with either kind of key, and the header is
 * simply omitted when there is nothing to send.
 *
 * Constructing the client here rather than at each call site means discovery
 * and repair cannot drift apart on authentication, for the same reason the
 * policy engine is built here: a run that authenticated differently from the
 * one that recorded the artifact is not a comparable run.
 */
export function anthropicClient(): Anthropic {
  const workspaceId = process.env['ANTHROPIC_WORKSPACE_ID'];
  return new Anthropic(
    workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {},
  );
}

export function requireAnthropicKey(): string {
  const key = process.env['ANTHROPIC_API_KEY'];
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.\n' +
        'Only `discover` needs it — `replay` never calls a model, which is the point.',
    );
  }
  return key;
}

/**
 * Let `secret`-classified inputs come from the environment.
 *
 * A password passed as `--input password=...` is written to shell history and
 * is visible in `ps` to every other process on the machine, which is a poor
 * ending for a system whose whole redaction story is that credentials never
 * come to rest anywhere. `HANDSPAN_INPUT_PASSWORD` is read from the process
 * environment (and therefore from the gitignored `.env`) instead.
 *
 * Deliberately narrow in two ways. Only `secret` inputs are eligible — every
 * other parameter is the *meaning* of the call, and quietly defaulting a member
 * id from an environment variable would be a genuinely dangerous convenience.
 * And an explicit `--input` always wins, so a caller can still override.
 *
 * An explicit CLI value stays supported rather than being removed: the mock
 * app's credentials are fixtures, and a demo that requires editing a dotfile
 * before anything runs is a worse demo.
 */
/**
 * Inputs the DEPLOYMENT supplies, not the caller.
 *
 * The obvious one is the operator identity. If a caller can set `operatorId`,
 * then a chatbot can be talked into running as `super1`, and the whole
 * teller-versus-supervisor distinction the target enforces becomes decorative
 * — the escalation path would be a formality anyone could route around by
 * asking nicely. Which identity the automation acts as is a property of how it
 * was deployed, in the same way its credential is.
 *
 * Configured rather than hardcoded, because a different institution may name
 * the field differently, and a deployment that genuinely wants per-call
 * identity can set this to empty and defend that choice.
 */
export function boundInputNames(): string[] {
  const raw = process.env['HANDSPAN_BOUND_INPUTS'] ?? 'operatorId';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function fillSecretsFromEnvironment(
  cap: { inputs: Array<{ name: string; sensitivity: string }> },
  supplied: Record<string, string>,
): Record<string, string> {
  const out = { ...supplied };

  const bound = new Set(boundInputNames());

  for (const p of cap.inputs) {
    if (p.sensitivity !== 'secret' && !bound.has(p.name)) continue;
    if (out[p.name] !== undefined) continue;
    const key = `HANDSPAN_INPUT_${p.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
    const value = process.env[key];
    if (value) {
      out[p.name] = value;
      // Name the variable, never the value.
      console.log(`  ${p.name} supplied from ${key}`);
    }
  }
  return out;
}
