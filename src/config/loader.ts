// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Config discovery, YAML parsing, validation, and env-var fallback.
 *
 * Discovery order: --config <path> → CRISISMODE_CONFIG env → ./crisismode.yaml
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SiteConfig } from './schema.js';
import { resolveCatalogEntry, resolveTarget, SERVICE_CATALOG } from '../framework/service-status/catalog.js';
import { STATUSPAGE_PROVIDER_IDS } from '../agent/llm-provider/provider-table.js';

export interface LoadConfigOptions {
  configPath?: string;
}

export interface LoadConfigResult {
  config: SiteConfig;
  source: 'file' | 'env-fallback';
  filePath?: string;
}

/**
 * Discover and load the site configuration.
 * Falls back to building a config from legacy env vars if no file is found.
 */
export function loadConfig(options?: LoadConfigOptions): LoadConfigResult {
  const filePath = discoverConfigPath(options?.configPath);

  if (filePath) {
    const config = loadConfigFile(filePath);
    return { config, source: 'file', filePath };
  }

  // No config file found — build from legacy env vars
  const config = buildLegacyConfig();
  return { config, source: 'env-fallback' };
}

/**
 * An explicitly requested config file (--config flag or CRISISMODE_CONFIG)
 * does not exist. Callers with detection fallbacks must NOT swallow this:
 * when the user names a config file, silently diagnosing something else
 * instead is dishonest — surface the error.
 */
export class ConfigNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigNotFoundError';
  }
}

/**
 * A config file exists and was parsed, but its content is invalid (bad
 * apiVersion/kind, a malformed target, a `services:` entry that collides
 * with a `targets:` name, ...). Sibling of `ConfigNotFoundError` for the
 * same reason: callers with detection fallbacks must NOT swallow this
 * either. A config that was found and rejected is a materially different
 * situation from no config existing at all — "No configuration found,
 * scanning localhost..." is a false thing to print when a file was found
 * and its content was the problem. Every validation throw inside
 * `loadConfigFile` (and the functions it calls) uses this class so a single
 * `instanceof` check at each swallow site catches all of them.
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Discover config file path using the priority chain.
 */
function discoverConfigPath(explicit?: string): string | undefined {
  // 1. Explicit --config flag
  if (explicit) {
    const resolved = resolve(explicit);
    if (!existsSync(resolved)) {
      throw new ConfigNotFoundError(`Config file not found: ${resolved}`);
    }
    return resolved;
  }

  // 2. CRISISMODE_CONFIG env var
  const envPath = process.env.CRISISMODE_CONFIG;
  if (envPath) {
    const resolved = resolve(envPath);
    if (!existsSync(resolved)) {
      throw new ConfigNotFoundError(`Config file not found (CRISISMODE_CONFIG): ${resolved}`);
    }
    return resolved;
  }

  // 3. ./crisismode.yaml in CWD
  const cwdPath = resolve('crisismode.yaml');
  if (existsSync(cwdPath)) {
    return cwdPath;
  }

  return undefined;
}

/**
 * Load and validate a config file.
 */
function loadConfigFile(filePath: string): SiteConfig {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed: unknown = parseYaml(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new ConfigValidationError(`Invalid config file: ${filePath} — expected a YAML object`);
  }

  const config = parsed as Record<string, unknown>;

  if (config.apiVersion !== 'crisismode/v1') {
    throw new ConfigValidationError(
      `Unsupported apiVersion: ${String(config.apiVersion)} — expected crisismode/v1.\n` +
      `  Suggestion: Set apiVersion to "crisismode/v1" in your config file.\n` +
      `  Run "pnpm run init" to generate a valid template.`,
    );
  }

  if (config.kind !== 'SiteConfig') {
    throw new ConfigValidationError(
      `Unsupported kind: ${String(config.kind)} — expected SiteConfig.\n` +
      `  Suggestion: Set kind to "SiteConfig" in your config file.`,
    );
  }

  const hasTargets = Array.isArray(config.targets) && config.targets.length > 0;
  const hasServices = Array.isArray(config.services) && config.services.length > 0;

  // `hasTargets` is false for a present-but-non-array `targets:` (e.g.
  // `targets: {}`), same as if it were absent — so a config with both a
  // malformed targets: and a valid services: passed validation entirely,
  // then `config.targets = config.targets ?? []` below kept the non-array
  // value (`??` only replaces null/undefined), and downstream `.map(...)`
  // calls (serviceTargetsFromConfig, runScan) threw a raw TypeError at
  // runtime instead of the "must be a list" error `targets: 'nope'` alone
  // already gets. Reject explicitly, before that error class can happen.
  if (config.targets !== undefined && !Array.isArray(config.targets)) {
    throw new ConfigValidationError(
      'config error: targets must be a list.\n' +
      '  Example:\n' +
      '    targets:\n' +
      '      - name: my-postgres\n' +
      '        kind: postgresql\n' +
      '        primary: { host: localhost, port: 5432 }',
    );
  }

  if (!hasTargets && !hasServices) {
    throw new ConfigValidationError(
      'Config must define at least one target or service. ' +
      'Add a `targets:` block or a `services:` list.\n' +
      '  Suggestion: Add a target block. Example:\n' +
      '    targets:\n' +
      '      - name: my-postgres\n' +
      '        kind: postgresql\n' +
      '        primary: { host: localhost, port: 5432 }\n' +
      '  Or a services list. Example:\n' +
      '    services:\n' +
      '      - github',
    );
  }

  if (hasTargets) {
    for (const target of config.targets as Record<string, unknown>[]) {
      validateTarget(target);
    }
  }

  if (config.network !== undefined) {
    validateNetwork(config.network);
  }

  if (config.services !== undefined) {
    validateServices(config.services);
  }

  // Runs whenever services: is present, not only alongside targets: — a
  // services-only config can still collide two of its own entries against
  // each other (see the function doc).
  if (hasServices) {
    validateNoServiceTargetCollision(
      hasTargets ? (config.targets as Record<string, unknown>[]) : [],
      config.services as unknown[],
    );
  }

  config.targets = config.targets ?? [];

  return config as unknown as SiteConfig;
}

function validateNetwork(network: unknown): void {
  if (typeof network !== 'object' || network === null || Array.isArray(network)) {
    throw new ConfigValidationError(
      'config error: network must be a mapping (e.g. network:\n  egressMbps: 100)',
    );
  }

  const { egressMbps } = network as Record<string, unknown>;
  if (egressMbps !== undefined) {
    if (typeof egressMbps !== 'number' || !Number.isFinite(egressMbps) || egressMbps <= 0) {
      throw new ConfigValidationError(
        'network.egressMbps must be a finite number greater than 0.\n' +
        '  Example: network: { egressMbps: 100 }',
      );
    }
  }
}

/**
 * A bare hostname/domain: no scheme, no path, no whitespace. Exported so
 * `crisismode down`'s ad-hoc argument parsing (src/cli/commands/down.ts) can
 * apply the same rule to a raw positional before handing it to DNS — the
 * config path already rejects these at load time via `validateServices`.
 */
export const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

function validServiceHint(): string {
  const sample = SERVICE_CATALOG.slice(0, 5).map((e) => e.id).join(', ');
  return `Valid catalog ids include: ${sample}.`;
}

function serviceEntryError(entry: unknown): ConfigValidationError {
  return new ConfigValidationError(
    `Invalid services entry: ${JSON.stringify(entry)}.\n` +
    '  Each entry must be a catalog id/alias, a bare domain (no scheme, path, or spaces), ' +
    'or { host, port } with a valid host and port 1-65535.\n' +
    `  ${validServiceHint()}`,
  );
}

/**
 * `services: [anthropic]` (or `openai`) would DNS-probe the literal hostname
 * "anthropic" — the service-status catalog deliberately excludes these ids
 * (spec's single-owner rule: the llm-provider agent already owns their
 * status endpoints via its own env-key detection). Letting the entry through
 * here produces the exact divergence `down anthropic` avoids by routing
 * through `STATUSPAGE_PROVIDER_IDS`'s table instead: `scan` would emit a
 * false unhealthy finding for a provider it never contacted, while `down`
 * reports it healthy from the real status page. Rejected at config load so
 * the two surfaces can't disagree.
 */
function llmProviderServiceEntryError(id: string): ConfigValidationError {
  return new ConfigValidationError(
    `Invalid services entry: ${JSON.stringify(id)}.\n` +
    `  "${id}" is covered automatically by the llm-provider agent when its API key is set — ` +
    `it must not also be listed in services:.\n` +
    `  Use \`crisismode down ${id}\` for an ad-hoc check instead.`,
  );
}

function validateServices(services: unknown): void {
  if (!Array.isArray(services)) {
    throw new ConfigValidationError(
      `config error: services must be a list.\n  ${validServiceHint()}`,
    );
  }

  for (const entry of services) {
    if (typeof entry === 'string') {
      const lower = entry.toLowerCase();
      if ((STATUSPAGE_PROVIDER_IDS as string[]).includes(lower)) {
        throw llmProviderServiceEntryError(lower);
      }
      if (resolveCatalogEntry(entry) === undefined && !HOSTNAME_PATTERN.test(entry)) {
        throw serviceEntryError(entry);
      }
      continue;
    }

    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      const { host, port } = entry as Record<string, unknown>;
      if (typeof host !== 'string' || host.length === 0 || !HOSTNAME_PATTERN.test(host)) {
        throw serviceEntryError(entry);
      }
      if (port !== undefined) {
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
          throw serviceEntryError(entry);
        }
      }
      continue;
    }

    throw serviceEntryError(entry);
  }
}

/**
 * `serviceTargetsFromConfig` (src/cli/service-targets.ts) synthesizes each
 * `services:` entry into a `service-status` target named after its resolved
 * id, then scan/watch append it to `config.targets` alongside the
 * user-declared ones. `AgentRegistry.createForTarget` resolves by name and
 * returns the *first* match — a `services:` id that collides with an
 * existing `targets:` name would silently run that other target's agent
 * under the service-status label (the checked service is never contacted,
 * and a coincidentally-healthy result reads as a false "service is up").
 * Caught here, at config load, rather than left to be discovered live.
 *
 * Also checks `services:` entries against EACH OTHER, not just against
 * `targets:` — two services entries that resolve to the same id (including
 * via alias, e.g. `flyio` and `fly`) synthesize two targets with the same
 * name, and the same first-match-wins behavior means only the first-listed
 * one ever runs. Runs even for a services-only config (no `targets:` at
 * all), since this collision doesn't need a targets: block to happen.
 */
function validateNoServiceTargetCollision(targets: Record<string, unknown>[], services: unknown[]): void {
  const targetsByName = new Map<string, Record<string, unknown>>();
  for (const target of targets) {
    if (typeof target.name === 'string') targetsByName.set(target.name, target);
  }

  const seenServiceEntries = new Map<string, unknown>();
  for (const entry of services) {
    const resolved = resolveTarget(entry as string | { host: string; port?: number });

    const colliding = targetsByName.get(resolved.id);
    if (colliding) {
      throw new ConfigValidationError(
        `Config error: services entry ${JSON.stringify(entry)} resolves to the name "${resolved.id}", ` +
        `which collides with targets[] entry "${String(colliding.name)}" (kind: ${String(colliding.kind)}).\n` +
        '  A services: entry is synthesized into its own service-status target using the same name — ' +
        'two targets sharing a name means only the first-listed one ever runs, and the other silently ' +
        'wears its label.\n' +
        '  Suggestion: rename the targets[] entry, or change the services[] id/alias/domain.',
      );
    }

    const priorEntry = seenServiceEntries.get(resolved.id);
    if (priorEntry !== undefined) {
      throw new ConfigValidationError(
        `Config error: services entries ${JSON.stringify(priorEntry)} and ${JSON.stringify(entry)} both resolve ` +
        `to the name "${resolved.id}" (catalog aliases like "flyio" and "fly" resolve to the same id) — ` +
        'only the first-listed one would ever run.\n' +
        '  Suggestion: remove the duplicate, or use distinct services.',
      );
    }
    seenServiceEntries.set(resolved.id, entry);
  }
}

function validateTarget(target: Record<string, unknown>): void {
  if (!target.name || typeof target.name !== 'string') {
    throw new ConfigValidationError(
      'Each target must have a "name" string.\n' +
      '  Example: name: my-postgres',
    );
  }
  if (!target.kind || typeof target.kind !== 'string') {
    throw new ConfigValidationError(
      `Target "${target.name}" must have a "kind" string (e.g. "postgresql", "redis").\n` +
      `  Supported kinds are determined by registered agents.`,
    );
  }
  // AWS target kinds use the aws config block instead of primary
  const isAwsKind = typeof target.kind === 'string' && target.kind.startsWith('aws-');
  if (isAwsKind) {
    const aws = target.aws as Record<string, unknown> | undefined;
    if (!aws || typeof aws.region !== 'string') {
      throw new ConfigValidationError(
        `Target "${target.name}" (kind: ${String(target.kind)}) requires an "aws" block with at least "region".\n` +
        `  Example: aws: { region: us-east-1, bucket: my-bucket }`,
      );
    }
  } else {
    const primary = target.primary as Record<string, unknown> | undefined;
    if (!primary || typeof primary.host !== 'string' || typeof primary.port !== 'number') {
      throw new ConfigValidationError(
        `Target "${target.name}" must have a primary with host (string) and port (number).\n` +
        `  Example: primary: { host: localhost, port: 5432 }`,
      );
    }
  }

  // Validate version format if provided
  if (target.version !== undefined && typeof target.version !== 'string') {
    throw new ConfigValidationError(
      `Target "${target.name}" version must be a string (e.g. "16.2", "7.0.0").\n` +
      `  Tip: Quote the version in YAML to prevent it being parsed as a number.`,
    );
  }
}

/**
 * Build a SiteConfig from legacy env vars for backward compatibility.
 */
function buildLegacyConfig(): SiteConfig {
  const pgHost = process.env.PG_HOST || 'localhost';
  const pgPort = parseInt(process.env.PG_PORT || '5432', 10);
  const pgReplicaPort = parseInt(process.env.PG_REPLICA_PORT || '5433', 10);
  const pgUser = process.env.PG_USER || 'crisismode';
  const pgPassword = process.env.PG_PASSWORD || 'crisismode';
  const pgDatabase = process.env.PG_DATABASE || 'crisismode';

  return {
    apiVersion: 'crisismode/v1',
    kind: 'SiteConfig',
    metadata: {
      name: 'legacy-env',
      environment: 'development',
    },
    ...(process.env.HUB_ENDPOINT
      ? { hub: { endpoint: process.env.HUB_ENDPOINT } }
      : {}),
    webhook: {
      port: parseInt(process.env.PORT || '3000', 10),
      ...(process.env.WEBHOOK_SECRET
        ? { secret: { type: 'value' as const, token: process.env.WEBHOOK_SECRET } }
        : {}),
    },
    targets: [
      {
        name: 'default-postgres',
        kind: 'postgresql',
        primary: { host: pgHost, port: pgPort, database: pgDatabase },
        replicas: [{ host: pgHost, port: pgReplicaPort, database: pgDatabase }],
        credentials: {
          type: 'value',
          username: pgUser,
          password: pgPassword,
        },
      },
    ],
  };
}

/**
 * Load config with auto-detection fallback.
 * Returns null config when no config file exists and no env vars are set.
 * The caller can then use detect.ts to probe localhost.
 */
export function loadConfigWithDetection(options?: LoadConfigOptions): {
  config: SiteConfig | null;
  source: 'file' | 'env-fallback' | 'none';
  filePath?: string;
} {
  try {
    const result = loadConfig(options);
    return result;
  } catch (err) {
    // A config file that doesn't exist, or one that exists but is invalid,
    // is a user error — not a cue to silently fall back to auto-detection.
    // "No configuration found" would be false in the second case: a file
    // was found, and its content was the problem.
    if (err instanceof ConfigNotFoundError || err instanceof ConfigValidationError) throw err;
    return { config: null, source: 'none' };
  }
}

/**
 * Parse --config <path> and --target <name> from process.argv.
 */
export function parseCliFlags(argv: string[]): { configPath?: string | undefined; targetName?: string | undefined } {
  let configPath: string | undefined;
  let targetName: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      configPath = argv[i + 1];
      i++;
    }
    if (argv[i] === '--target' && argv[i + 1]) {
      targetName = argv[i + 1];
      i++;
    }
  }

  return { configPath, targetName };
}
