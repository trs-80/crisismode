// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Playbook discovery.
 *
 * Discovers playbooks from:
 *   1. `~/.crisismode/playbooks/` — user playbooks
 *   2. `./playbooks/` — project-local playbooks
 *   3. Paths listed in the `CRISISMODE_PLAYBOOK_PATH` environment variable (colon-separated)
 *
 * Each `.md` file in those directories is a candidate playbook.
 * Discovery is non-blocking and fault-tolerant — a broken playbook is skipped with a warning.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import type { PlaybookFrontmatter, DiscoveredPlaybook, PlaybookDiscoveryResult } from './types.js';
import { validatePlaybookFrontmatter } from './parser.js';

// ── Discovery ──

/**
 * Discover all playbooks from standard locations.
 *
 * Search order (later sources shadow earlier ones by name):
 *   1. User directory: `~/.crisismode/playbooks/`
 *   2. Project directory: `<projectDir>/playbooks/`
 *   3. `CRISISMODE_PLAYBOOK_PATH` entries
 */
export async function discoverPlaybooks(
  options?: { projectDir?: string },
): Promise<PlaybookDiscoveryResult> {
  const projectDir = options?.projectDir ?? process.cwd();
  const playbooks: DiscoveredPlaybook[] = [];
  const warnings: Array<{ path: string; reason: string }> = [];
  const seen = new Set<string>();

  // 1. User-level playbooks
  const userPlaybookDir = join(homedir(), '.crisismode', 'playbooks');
  await scanDirectory(userPlaybookDir, 'user', playbooks, warnings, seen);

  // 2. Project-level playbooks
  const projectPlaybookDir = join(projectDir, 'playbooks');
  await scanDirectory(projectPlaybookDir, 'project', playbooks, warnings, seen);

  // 3. CRISISMODE_PLAYBOOK_PATH
  const envPath = process.env.CRISISMODE_PLAYBOOK_PATH;
  if (envPath) {
    for (const dir of envPath.split(':').filter(Boolean)) {
      await scanDirectory(resolve(dir), 'env', playbooks, warnings, seen);
    }
  }

  return { playbooks, warnings };
}

// ── Internal ──

async function scanDirectory(
  dir: string,
  source: DiscoveredPlaybook['source'],
  playbooks: DiscoveredPlaybook[],
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
    if (!entry.endsWith('.md')) continue;

    const filePath = join(dir, entry);

    // Ensure it's a file, not a directory
    const stats = await stat(filePath).catch(() => null);
    if (!stats?.isFile()) continue;

    try {
      const content = await readFile(filePath, 'utf-8');
      const frontmatterObj = extractFrontmatter(content);

      if (frontmatterObj === null) {
        warnings.push({ path: filePath, reason: 'Missing or invalid YAML frontmatter' });
        continue;
      }

      const validation = validatePlaybookFrontmatter(frontmatterObj);
      if (!validation.valid) {
        const details = validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
        warnings.push({ path: filePath, reason: `Invalid frontmatter: ${details}` });
        continue;
      }

      const frontmatter = frontmatterObj as unknown as PlaybookFrontmatter;

      // Deduplicate by name (later sources shadow earlier ones)
      if (seen.has(frontmatter.name)) {
        const idx = playbooks.findIndex((p) => p.frontmatter.name === frontmatter.name);
        if (idx >= 0) {
          playbooks[idx] = { filePath, frontmatter, source };
        }
      } else {
        seen.add(frontmatter.name);
        playbooks.push({ filePath, frontmatter, source });
      }
    } catch (err) {
      warnings.push({
        path: filePath,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function extractFrontmatter(content: string): Record<string, unknown> | null {
  const lines = content.split('\n');

  if (lines[0]?.trim() !== '---') return null;

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) return null;

  const yamlStr = lines.slice(1, closingIndex).join('\n');

  try {
    const parsed = parseYaml(yamlStr);
    if (parsed == null || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
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
