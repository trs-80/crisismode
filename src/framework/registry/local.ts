// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Local agent plugin discovery.
 *
 * Scans for community agent packages containing crisismode-agent.json:
 *   1. ~/.crisismode/agents/ — user-installed plugins
 *   2. ./agents/ — project-local plugins
 *   3. CRISISMODE_AGENT_PATH entries
 *   4. node_modules/@crisismode/ — npm-installed agent packages
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type {
  AgentPluginManifest,
  DiscoveredAgentPlugin,
  AgentPluginDiscoveryResult,
} from './types.js';
import { dirExists, fileExists } from '../fs-utils.js';

const MANIFEST_FILENAME = 'crisismode-agent.json';

// ── Discovery ──

/**
 * Discover all agent/playbook plugins from standard locations.
 *
 * Search order (later sources shadow earlier ones by name):
 *   1. User directory: `~/.crisismode/agents/`
 *   2. Project directory: `./agents/`
 *   3. `CRISISMODE_AGENT_PATH` entries
 *   4. `node_modules/@crisismode/` packages
 */
export async function discoverAgentPlugins(
  options?: { projectDir?: string },
): Promise<AgentPluginDiscoveryResult> {
  const projectDir = options?.projectDir ?? process.cwd();
  const plugins: DiscoveredAgentPlugin[] = [];
  const warnings: Array<{ path: string; reason: string }> = [];
  const seen = new Set<string>();

  // 1. User-level plugins
  const userAgentDir = join(homedir(), '.crisismode', 'agents');
  await scanDirectory(userAgentDir, 'user', plugins, warnings, seen);

  // 2. Project-level plugins
  const projectAgentDir = join(projectDir, 'agents');
  await scanDirectory(projectAgentDir, 'project', plugins, warnings, seen);

  // 3. CRISISMODE_AGENT_PATH
  const envPath = process.env.CRISISMODE_AGENT_PATH;
  if (envPath) {
    for (const dir of envPath.split(':').filter(Boolean)) {
      await scanDirectory(resolve(dir), 'env', plugins, warnings, seen);
    }
  }

  // 4. node_modules/@crisismode/ packages
  const nmScopeDir = join(projectDir, 'node_modules', '@crisismode');
  await scanDirectory(nmScopeDir, 'node_modules', plugins, warnings, seen);

  return { plugins, warnings };
}

// ── Internal ──

async function scanDirectory(
  dir: string,
  source: DiscoveredAgentPlugin['source'],
  plugins: DiscoveredAgentPlugin[],
  warnings: Array<{ path: string; reason: string }>,
  seen: Set<string>,
): Promise<void> {
  if (!(await dirExists(dir))) return;

  let entries: string[];
  try {
    entries = (await readdir(dir)).sort();
  } catch {
    warnings.push({ path: dir, reason: 'Failed to read directory' });
    return;
  }

  for (const entry of entries) {
    const pluginDir = join(dir, entry);

    // Each entry should be a subdirectory containing a crisismode-agent.json
    const stats = await stat(pluginDir).catch(() => null);
    if (!stats?.isDirectory()) continue;

    // The @crisismode npm scope also holds non-plugin packages (e.g. the
    // types-only agent-sdk). A scoped package without a manifest is not
    // claiming to be an agent plugin — skip it silently. Explicit agent
    // directories still warn, since a manifest-less entry there is likely
    // a mistake.
    if (source === 'node_modules' && !(await fileExists(join(pluginDir, MANIFEST_FILENAME)))) {
      continue;
    }

    try {
      const manifest = await readManifest(pluginDir);
      const plugin: DiscoveredAgentPlugin = { pluginDir, manifest, source };

      // Deduplicate by name (later sources shadow earlier)
      if (seen.has(manifest.name)) {
        const idx = plugins.findIndex((p) => p.manifest.name === manifest.name);
        if (idx >= 0) {
          plugins[idx] = plugin;
        }
      } else {
        seen.add(manifest.name);
        plugins.push(plugin);
      }
    } catch (err) {
      warnings.push({
        path: pluginDir,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function readManifest(pluginDir: string): Promise<AgentPluginManifest> {
  const manifestPath = join(pluginDir, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf-8');
  } catch {
    throw new Error(`Missing ${MANIFEST_FILENAME} in ${pluginDir}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${manifestPath}`);
  }

  // Validate required fields
  const m = parsed as Record<string, unknown>;
  if (!m.name || typeof m.name !== 'string') {
    throw new Error(`${MANIFEST_FILENAME} missing "name" in ${pluginDir}`);
  }
  if (!m.version || typeof m.version !== 'string') {
    throw new Error(`${MANIFEST_FILENAME} missing "version" in ${pluginDir}`);
  }
  if (!m.description || typeof m.description !== 'string') {
    throw new Error(`${MANIFEST_FILENAME} missing "description" in ${pluginDir}`);
  }
  if (!m.kind || (m.kind !== 'agent' && m.kind !== 'playbook')) {
    throw new Error(`${MANIFEST_FILENAME} invalid or missing "kind" in ${pluginDir}`);
  }
  if (!m.targetKinds || !Array.isArray(m.targetKinds) || m.targetKinds.length === 0) {
    throw new Error(`${MANIFEST_FILENAME} missing or empty "targetKinds" in ${pluginDir}`);
  }
  const cm = m.crisismode as Record<string, unknown> | undefined;
  if (!cm || typeof cm !== 'object' || !cm.minVersion || typeof cm.minVersion !== 'string') {
    throw new Error(`${MANIFEST_FILENAME} missing "crisismode.minVersion" in ${pluginDir}`);
  }

  // Build validated manifest
  const riskProfile = m.riskProfile as Record<string, unknown> | undefined;
  type RP = NonNullable<AgentPluginManifest['riskProfile']>;

  return {
    name: m.name as string,
    version: m.version as string,
    description: m.description as string,
    kind: m.kind as 'agent' | 'playbook',
    targetKinds: m.targetKinds as string[],
    ...(typeof m.entryPoint === 'string' ? { entryPoint: m.entryPoint } : {}),
    ...(riskProfile
      ? {
          riskProfile: {
            maxRiskLevel: riskProfile.maxRiskLevel as RP['maxRiskLevel'],
            dataLossPossible: riskProfile.dataLossPossible === true,
          },
        }
      : {}),
    ...(typeof m.author === 'string' ? { author: m.author } : {}),
    ...(typeof m.license === 'string' ? { license: m.license } : {}),
    ...(typeof m.repository === 'string' ? { repository: m.repository } : {}),
    crisismode: {
      minVersion: cm.minVersion as string,
      ...(typeof cm.sdkVersion === 'string' ? { sdkVersion: cm.sdkVersion } : {}),
    },
  };
}
