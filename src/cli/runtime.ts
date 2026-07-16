// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Shared CLI runtime helpers for the "resolve config → build registry →
 * create agent" sequence used by the diagnose, watch, live, and interactive
 * entry points.
 *
 * Each piece is deliberately small and composable: a site may share the
 * config-loading step but diverge on how it creates agents (or vice versa),
 * so callers pick only the pieces that are a byte-identical fit.
 */

import { loadConfig, ConfigNotFoundError } from '../config/loader.js';
import type { LoadConfigResult } from '../config/loader.js';
import { AgentRegistry } from '../config/agent-registry.js';
import type { AgentInstance } from '../config/agent-registry.js';
import type { SiteConfig } from '../config/schema.js';
import { detectServices } from './detect.js';
import { mergeLocalTargets } from './local-agents.js';
import { printInfo, printDetection } from './output.js';

/**
 * Format the human-readable config source label from a load result.
 * When a file was found, `filePath` is always present; the `?? 'crisismode.yaml'`
 * fallback exists only to satisfy the optional type.
 */
export function formatConfigSource(
  result: { source: LoadConfigResult['source']; filePath?: string | undefined },
): string {
  return result.source === 'file' ? result.filePath ?? 'crisismode.yaml' : 'env-var fallback';
}

/**
 * Build a minimal SiteConfig from detected localhost services.
 * Used as the fallback when no config file or env vars are present.
 */
export function buildConfigFromDetection(
  detected: Array<{ kind: string; host: string; port: number }>,
): SiteConfig {
  return {
    apiVersion: 'crisismode/v1',
    kind: 'SiteConfig',
    metadata: { name: 'auto-detected', environment: 'development' },
    targets: detected.map((s) => ({
      name: `detected-${s.kind}`,
      kind: s.kind,
      primary: { host: s.host, port: s.port },
      replicas: [],
      credentials: { type: 'value' as const, username: '', password: '' },
    })),
  };
}

/**
 * Load the site config (falling back to localhost detection), then inject the
 * built-in local health agents (DNS, disk). Prints the same detection and
 * `Config: <source>` output the diagnose/watch flows have always emitted.
 */
export async function loadConfigWithLocalTargets(
  opts: { configPath?: string | undefined },
): Promise<{ config: SiteConfig; source: string }> {
  let config: SiteConfig;
  let source: string;
  try {
    const result = loadConfig(opts.configPath !== undefined ? { configPath: opts.configPath } : {});
    config = result.config;
    source = formatConfigSource(result);
  } catch (err) {
    // An explicitly named config file that doesn't exist is a user error,
    // not a cue to silently diagnose something else.
    if (err instanceof ConfigNotFoundError) throw err;
    printInfo('No configuration found, scanning localhost...');
    const services = await detectServices();
    printDetection(services);

    const detected = services.filter((s) => s.detected);
    config = buildConfigFromDetection(detected);
    source = 'auto-detected';
  }

  // Inject local health agents (DNS, disk) so they work without explicit config
  config = { ...config, targets: mergeLocalTargets(config.targets) };

  printInfo(`Config: ${source}`);
  console.log('');

  return { config, source };
}

/**
 * Resolve the target to run against and discover its version (best-effort).
 * Picks the named target when provided, otherwise the first configured target.
 */
export async function createAgentForTarget(
  registry: AgentRegistry,
  targetName?: string,
): Promise<AgentInstance> {
  const instance = targetName
    ? await registry.createForTarget(targetName)
    : await registry.createFirst();
  await AgentRegistry.discoverVersion(instance);
  return instance;
}
