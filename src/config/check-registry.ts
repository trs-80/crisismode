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
  /**
   * Legacy digest — sha256 of the sorted file contents concatenated.
   * Kept accurate so already-released clients keep verifying; new clients
   * prefer sha256v2. For `community` (tarball) entries this is the digest of
   * the downloaded archive itself, not of the extracted files.
   */
  sha256: string;
  /**
   * Manifest-bound digest — sha256 over `<sha256>  <name>\n` lines, sorted by
   * name. Binds filenames and file boundaries, which sha256 does not.
   * Preferred whenever present.
   */
  sha256v2?: string;
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

/** Redirect hops allowed before a chain is treated as a loop. */
const MAX_REDIRECTS = 5;

/**
 * Response size ceiling. Check plugins are a few KB of script; this is a
 * guard against a hostile server streaming without end, not a real limit.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface FetchOptions {
  /** Override the response size ceiling (bytes). */
  maxBytes?: number;
  /** Override the redirect hop limit. */
  maxRedirects?: number;
}

/**
 * Resolve a redirect Location against the URL that produced it, rejecting
 * unsafe hops.
 *
 * Location may legitimately be relative (GitHub's raw host does this), so it
 * is resolved rather than used verbatim. Two hops are refused outright: any
 * non-HTTP scheme, and HTTPS→HTTP, which would silently drop a fetch of
 * executable plugin code onto plaintext.
 */
export function resolveRedirectTarget(from: string, location: string): URL {
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    throw new Error(`Invalid redirect Location "${location}" while fetching ${from}`);
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(
      `Refusing to follow redirect to unsupported scheme "${target.protocol}" (from ${from})`,
    );
  }

  if (new URL(from).protocol === 'https:' && target.protocol === 'http:') {
    throw new Error(`Refusing HTTPS→HTTP downgrade redirect: ${from} → ${target.href}`);
  }

  return target;
}

/** Fetch a URL as a Buffer with redirect, scheme, and size limits enforced. */
function fetchRaw(url: string, options?: FetchOptions, hopsLeft?: number): Promise<Buffer> {
  const maxBytes = options?.maxBytes ?? MAX_RESPONSE_BYTES;
  const maxRedirects = options?.maxRedirects ?? MAX_REDIRECTS;
  const remaining = hopsLeft ?? maxRedirects;

  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`Unsupported URL scheme "${parsed.protocol}" for ${url}`));
      return;
    }

    const client = parsed.protocol === 'https:' ? get : httpGet;
    const req = client(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); // drain the redirect body
        if (remaining <= 0) {
          reject(new Error(`Too many redirects (>${maxRedirects}) fetching ${url}`));
          return;
        }
        let target: URL;
        try {
          target = resolveRedirectTarget(url, res.headers.location);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        fetchRaw(target.href, options, remaining - 1).then(resolve, reject);
        return;
      }

      if (status >= 400) {
        res.resume();
        reject(new Error(`HTTP ${status} fetching ${url}`));
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;

      res.on('data', (chunk: Buffer) => {
        if (aborted) return;
        size += chunk.length;
        if (size > maxBytes) {
          aborted = true;
          reject(new Error(`Response exceeded the ${maxBytes} byte size limit fetching ${url}`));
          res.destroy();
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (!aborted) resolve(Buffer.concat(chunks));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

/** Fetch a URL as a string, following redirects within policy. */
export function fetchUrl(url: string, options?: FetchOptions): Promise<string> {
  return fetchRaw(url, options).then((buf) => buf.toString('utf-8'));
}

/** Fetch a URL as a Buffer, following redirects within policy. */
export function fetchBuffer(url: string, options?: FetchOptions): Promise<Buffer> {
  return fetchRaw(url, options);
}
