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
 * Discover config file path using the priority chain.
 */
function discoverConfigPath(explicit?: string): string | undefined {
  // 1. Explicit --config flag
  if (explicit) {
    const resolved = resolve(explicit);
    if (!existsSync(resolved)) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    return resolved;
  }

  // 2. CRISISMODE_CONFIG env var
  const envPath = process.env.CRISISMODE_CONFIG;
  if (envPath) {
    const resolved = resolve(envPath);
    if (!existsSync(resolved)) {
      throw new Error(`Config file not found (CRISISMODE_CONFIG): ${resolved}`);
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
    throw new Error(`Unsupported apiVersion: ${String(config.apiVersion)} — expected crisismode/v1`);
  }

  if (config.kind !== 'SiteConfig') {
    throw new Error(`Unsupported kind: ${String(config.kind)} — expected SiteConfig`);
  }

  if (!Array.isArray(config.targets) || config.targets.length === 0) {
    throw new Error('Config must define at least one target');
  }

  for (const target of config.targets as Record<string, unknown>[]) {
    validateTarget(target);
  }

  return config as unknown as SiteConfig;
}

function validateTarget(target: Record<string, unknown>): void {
  if (!target.name || typeof target.name !== 'string') {
    throw new Error('Each target must have a "name" string');
  }
  if (!target.kind || typeof target.kind !== 'string') {
    throw new Error(`Target "${target.name}" must have a "kind" string`);
  }
  const primary = target.primary as Record<string, unknown> | undefined;
  if (!primary || typeof primary.host !== 'string' || typeof primary.port !== 'number') {
    throw new Error(`Target "${target.name}" must have a primary with host (string) and port (number)`);
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
    hub: process.env.HUB_ENDPOINT
      ? { endpoint: process.env.HUB_ENDPOINT }
      : undefined,
    webhook: {
      port: parseInt(process.env.PORT || '3000', 10),
      secret: process.env.WEBHOOK_SECRET
        ? { type: 'value', token: process.env.WEBHOOK_SECRET }
        : undefined,
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
 * Parse --config <path> and --target <name> from process.argv.
 */
export function parseCliFlags(argv: string[]): { configPath?: string; targetName?: string } {
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
