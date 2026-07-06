// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Zero-config drift expectations from .env.example / .env.template.
 *
 * Presence-only by construction: we extract KEY NAMES from the template and
 * check each is set in the environment. Values are never read, compared,
 * logged, or stored.
 */

import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfigExpectation } from './live-client.js';

export const ENV_EXAMPLE_FILENAMES = ['.env.example', '.env.template'];

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Extract declared keys from env-template file content. */
export function parseEnvExampleKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const match = KEY_LINE.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/** Locate the env template: explicit path wins, else .env.example, else .env.template. */
export async function findEnvExample(cwd: string, explicitPath?: string): Promise<string | null> {
  const candidates = explicitPath
    ? [explicitPath]
    : ENV_EXAMPLE_FILENAMES.map((f) => join(cwd, f));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Build presence-only expectations from the discovered env template. */
export async function buildPresenceExpectations(
  cwd: string,
  explicitPath?: string,
): Promise<ConfigExpectation[]> {
  const path = await findEnvExample(cwd, explicitPath);
  if (!path) return [];

  const content = await readFile(path, 'utf-8');
  return parseEnvExampleKeys(content).map((key) => ({
    path: key,
    expected: null,
    source: 'env' as const,
    masked: true,
    presence: true,
  }));
}
