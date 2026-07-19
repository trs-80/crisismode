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
    throw new Error(`Invalid config file: ${filePath} — expected a YAML object`);
  }

  const config = parsed as Record<string, unknown>;

  if (config.apiVersion !== 'crisismode/v1') {
    throw new Error(
      `Unsupported apiVersion: ${String(config.apiVersion)} — expected crisismode/v1.\n` +
      `  Suggestion: Set apiVersion to "crisismode/v1" in your config file.\n` +
      `  Run "pnpm run init" to generate a valid template.`,
    );
  }

  if (config.kind !== 'SiteConfig') {
    throw new Error(
      `Unsupported kind: ${String(config.kind)} — expected SiteConfig.\n` +
      `  Suggestion: Set kind to "SiteConfig" in your config file.`,
    );
  }

  if (!Array.isArray(config.targets) || config.targets.length === 0) {
    throw new Error(
      'Config must define at least one target.\n' +
      '  Suggestion: Add a target block. Example:\n' +
      '    targets:\n' +
      '      - name: my-postgres\n' +
      '        kind: postgresql\n' +
      '        primary: { host: localhost, port: 5432 }',
    );
  }

  for (const target of config.targets as Record<string, unknown>[]) {
    validateTarget(target);
  }

  if (config.network !== undefined) {
    validateNetwork(config.network);
  }

  return config as unknown as SiteConfig;
}

function validateNetwork(network: unknown): void {
  if (typeof network !== 'object' || network === null || Array.isArray(network)) {
    throw new Error(
      'config error: network must be a mapping (e.g. network:\n  egressMbps: 100)',
    );
  }

  const { egressMbps } = network as Record<string, unknown>;
  if (egressMbps !== undefined) {
    if (typeof egressMbps !== 'number' || !Number.isFinite(egressMbps) || egressMbps <= 0) {
      throw new Error(
        'network.egressMbps must be a finite number greater than 0.\n' +
        '  Example: network: { egressMbps: 100 }',
      );
    }
  }
}

function validateTarget(target: Record<string, unknown>): void {
  if (!target.name || typeof target.name !== 'string') {
    throw new Error(
      'Each target must have a "name" string.\n' +
      '  Example: name: my-postgres',
    );
  }
  if (!target.kind || typeof target.kind !== 'string') {
    throw new Error(
      `Target "${target.name}" must have a "kind" string (e.g. "postgresql", "redis").\n` +
      `  Supported kinds are determined by registered agents.`,
    );
  }
  // AWS target kinds use the aws config block instead of primary
  const isAwsKind = typeof target.kind === 'string' && target.kind.startsWith('aws-');
  if (isAwsKind) {
    const aws = target.aws as Record<string, unknown> | undefined;
    if (!aws || typeof aws.region !== 'string') {
      throw new Error(
        `Target "${target.name}" (kind: ${String(target.kind)}) requires an "aws" block with at least "region".\n` +
        `  Example: aws: { region: us-east-1, bucket: my-bucket }`,
      );
    }
  } else {
    const primary = target.primary as Record<string, unknown> | undefined;
    if (!primary || typeof primary.host !== 'string' || typeof primary.port !== 'number') {
      throw new Error(
        `Target "${target.name}" must have a primary with host (string) and port (number).\n` +
        `  Example: primary: { host: localhost, port: 5432 }`,
      );
    }
  }

  // Validate version format if provided
  if (target.version !== undefined && typeof target.version !== 'string') {
    throw new Error(
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
    if (err instanceof ConfigNotFoundError) throw err;
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
