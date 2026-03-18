// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Check plugin discovery.
 *
 * Discovers external check plugins from:
 *   1. `~/.crisismode/checks/` — user-installed plugins
 *   2. `./checks/` — project-local plugins
 *   3. Paths listed in the `CRISISMODE_CHECK_PATH` environment variable (colon-separated)
 *
 * Each plugin directory must contain a `manifest.json` declaring the plugin contract.
 * Discovery is non-blocking and fault-tolerant — a broken plugin is skipped with a warning.
 */

import { readdir, readFile, access, stat } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { constants } from 'node:fs';
import type { CheckPluginManifest } from './check-plugin.js';

// ── Types ──

export interface DiscoveredPlugin {
  /** Resolved path to the plugin directory */
  pluginDir: string;
  /** Resolved path to the executable */
  executablePath: string;
  /** Parsed plugin manifest */
  manifest: CheckPluginManifest;
  /** Where the plugin was discovered from */
  source: 'user' | 'project' | 'env';
}

export interface DiscoveryResult {
  /** Successfully discovered plugins */
  plugins: DiscoveredPlugin[];
  /** Warnings for plugins that failed to load */
  warnings: DiscoveryWarning[];
}

export interface DiscoveryWarning {
  path: string;
  reason: string;
}

// ── Discovery ──

/**
 * Discover all check plugins from standard locations.
 *
 * Search order (later sources can shadow earlier ones by name):
 *   1. User directory: `~/.crisismode/checks/`
 *   2. Project directory: `./checks/`
 *   3. `CRISISMODE_CHECK_PATH` entries
 */
export async function discoverCheckPlugins(
  options?: { projectDir?: string },
): Promise<DiscoveryResult> {
  const projectDir = options?.projectDir ?? process.cwd();
  const plugins: DiscoveredPlugin[] = [];
  const warnings: DiscoveryWarning[] = [];
  const seen = new Set<string>();

  // 1. User-level plugins
  const userCheckDir = join(homedir(), '.crisismode', 'checks');
  await scanDirectory(userCheckDir, 'user', plugins, warnings, seen);

  // 2. Project-level plugins
  const projectCheckDir = join(projectDir, 'checks');
  await scanDirectory(projectCheckDir, 'project', plugins, warnings, seen);

  // 3. CRISISMODE_CHECK_PATH
  const envPath = process.env.CRISISMODE_CHECK_PATH;
  if (envPath) {
    for (const dir of envPath.split(':').filter(Boolean)) {
      await scanDirectory(resolve(dir), 'env', plugins, warnings, seen);
    }
  }

  return { plugins, warnings };
}

/**
 * Load a single plugin from a directory path.
 * Useful for testing or explicitly loading a plugin.
 */
export async function loadPlugin(
  pluginDir: string,
  source: DiscoveredPlugin['source'] = 'project',
): Promise<DiscoveredPlugin> {
  const manifest = await readManifest(pluginDir);
  const executablePath = resolveExecutable(pluginDir, manifest.executable);
  await validateExecutable(executablePath);
  return { pluginDir, executablePath, manifest, source };
}

// ── Internal ──

async function scanDirectory(
  dir: string,
  source: DiscoveredPlugin['source'],
  plugins: DiscoveredPlugin[],
  warnings: DiscoveryWarning[],
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

    // Each entry should be a subdirectory containing a manifest.json
    const stats = await stat(pluginDir).catch(() => null);
    if (!stats?.isDirectory()) continue;

    try {
      const plugin = await loadPlugin(pluginDir, source);

      // Deduplicate by name (later sources shadow earlier)
      if (seen.has(plugin.manifest.name)) {
        // Replace the existing plugin
        const idx = plugins.findIndex((p) => p.manifest.name === plugin.manifest.name);
        if (idx >= 0) {
          plugins[idx] = plugin;
        }
      } else {
        seen.add(plugin.manifest.name);
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

async function readManifest(pluginDir: string): Promise<CheckPluginManifest> {
  const manifestPath = join(pluginDir, 'manifest.json');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf-8');
  } catch {
    throw new Error(`Missing manifest.json in ${pluginDir}`);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${manifestPath}`);
  }

  // Minimal validation
  const m = manifest as Record<string, unknown>;
  if (!m.name || typeof m.name !== 'string') {
    throw new Error(`manifest.json missing "name" in ${pluginDir}`);
  }
  if (!m.executable || typeof m.executable !== 'string') {
    throw new Error(`manifest.json missing "executable" in ${pluginDir}`);
  }
  if (!m.verbs || !Array.isArray(m.verbs) || m.verbs.length === 0) {
    throw new Error(`manifest.json missing or empty "verbs" in ${pluginDir}`);
  }
  if (!m.targetKinds || !Array.isArray(m.targetKinds)) {
    throw new Error(`manifest.json missing "targetKinds" in ${pluginDir}`);
  }

  return {
    name: m.name as string,
    description: (m.description as string) ?? '',
    version: (m.version as string) ?? '0.0.0',
    targetKinds: m.targetKinds as string[],
    verbs: m.verbs as CheckPluginManifest['verbs'],
    executable: m.executable as string,
    maxRiskLevel: m.maxRiskLevel as CheckPluginManifest['maxRiskLevel'],
    timeoutMs: typeof m.timeoutMs === 'number' ? m.timeoutMs : undefined,
    author: typeof m.author === 'string' ? m.author : undefined,
    license: typeof m.license === 'string' ? m.license : undefined,
  };
}

function resolveExecutable(pluginDir: string, executable: string): string {
  if (isAbsolute(executable)) return executable;
  return join(pluginDir, executable);
}

async function validateExecutable(path: string): Promise<void> {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`Plugin executable not found or not executable: ${path}`);
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}
