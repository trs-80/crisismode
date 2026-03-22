// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Check plugin registry — types, fetch, and search logic.
 *
 * The registry index is a JSON file listing available check plugins.
 * It can be fetched from GitHub (for latest updates) or loaded from
 * the bundled local copy (for offline use).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:https';
import { get as httpGet } from 'node:http';

// ── Types ──

export interface CheckRegistry {
  schemaVersion: number;
  updatedAt: string;
  checks: CheckRegistryEntry[];
}

export interface CheckRegistryEntry {
  name: string;
  description: string;
  version: string;
  targetKinds: string[];
  format?: 'crisismode' | 'nagios' | 'goss' | 'sensu';
  verbs: Array<'health' | 'diagnose' | 'plan'>;
  author?: string;
  license?: string;
  source: 'builtin' | 'community';
  url: string;
  sha256: string;
  /** For builtin source: individual files to download from the url base path. */
  files?: string[];
}

// ── Constants ──

export const REGISTRY_RAW_URL =
  'https://raw.githubusercontent.com/trs-80/crisismode/main/src/config/check-registry.json';

const FETCH_TIMEOUT_MS = 10_000;

// ── Functions ──

/** Load the bundled registry index from disk (offline fallback). */
export function loadLocalRegistry(): CheckRegistry {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const registryPath = resolve(__dirname, '../../src/config/check-registry.json');

  // Try source location first, then bundled dist location
  try {
    return JSON.parse(readFileSync(registryPath, 'utf-8')) as CheckRegistry;
  } catch {
    const distPath = resolve(__dirname, '../config/check-registry.json');
    try {
      return JSON.parse(readFileSync(distPath, 'utf-8')) as CheckRegistry;
    } catch {
      // Last resort: look relative to current file
      const localPath = resolve(__dirname, 'check-registry.json');
      return JSON.parse(readFileSync(localPath, 'utf-8')) as CheckRegistry;
    }
  }
}

/** Fetch the latest registry index from GitHub. Falls back to local on failure. */
export async function fetchRegistry(): Promise<CheckRegistry> {
  try {
    const data = await fetchUrl(REGISTRY_RAW_URL);
    return JSON.parse(data) as CheckRegistry;
  } catch {
    return loadLocalRegistry();
  }
}

/** Filter registry entries by substring match on name, description, or targetKinds. */
export function matchEntries(checks: CheckRegistryEntry[], query: string): CheckRegistryEntry[] {
  if (!query) return checks;
  const lower = query.toLowerCase();
  return checks.filter((c) =>
    c.name.toLowerCase().includes(lower) ||
    c.description.toLowerCase().includes(lower) ||
    c.targetKinds.some((k) => k.toLowerCase().includes(lower)),
  );
}

// ── Internal helpers ──

/** Fetch a URL as a string, following redirects. */
export function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? get : httpGet;
    const req = client(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve, reject);
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

/** Fetch a URL as a Buffer, following redirects. */
export function fetchBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? get : httpGet;
    const req = client(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchBuffer(res.headers.location).then(resolve, reject);
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}
