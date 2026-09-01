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
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PolicyEngine } from './safety/policy.js';
import { Redactor } from './safety/redaction.js';

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(here, '..');

export const PATHS = {
  policy: join(PROJECT_ROOT, 'policy.yaml'),
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

export function newRunId(prefix: 'disc' | 'replay' | 'verify' | 'drift' | 'repair'): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${prefix}-${stamp}-${randomUUID().slice(0, 6)}`;
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
