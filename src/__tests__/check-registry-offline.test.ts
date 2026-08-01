// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * The bundled registry index must be available without reading a file.
 *
 * loadLocalRegistry() is the offline fallback: fetchRegistry() calls it
 * whenever the network fetch fails. It resolved the index by walking three
 * candidate paths on disk, all of which are relative to the source tree — so
 * it only ever worked when running from a checkout:
 *
 *   published npm package  dist/config/check-registry.json is absent, because
 *                          tsc does not copy JSON to outDir
 *   esbuild bundle         all three candidates resolve outside the bundle dir
 *   standalone binary      single file, so no sibling JSON can exist at all
 *
 * That last case is the primary distribution channel. Compiling the index in
 * rather than reading it is what makes the fallback real, so the contract
 * asserted here is "works with no filesystem access".
 */

import { describe, it, expect, vi } from 'vitest';
import type * as NodeFs from 'node:fs';

// Any attempt to read the index off disk must fail loudly in this file.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    readFileSync: () => {
      throw new Error('EPERM: filesystem unavailable in this test');
    },
  };
});

const { loadLocalRegistry } = await import('../config/check-registry.js');

describe('loadLocalRegistry without filesystem access', () => {
  it('returns the bundled index when no file can be read', () => {
    const registry = loadLocalRegistry();
    expect(registry.checks.length).toBeGreaterThan(0);
  });

  it('carries the full builtin check set', () => {
    const names = loadLocalRegistry().checks.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        'check-certificate-expiry',
        'check-disk-usage',
        'check-dns-resolution',
        'check-http-endpoint',
        'check-memory-usage',
        'example-goss-system',
        'example-nagios-uptime',
        'example-sensu-metrics',
      ].sort(),
    );
  });

  it('carries both checksum fields for every builtin entry', () => {
    for (const entry of loadLocalRegistry().checks) {
      if (entry.source !== 'builtin') continue;
      expect(entry.sha256, `${entry.name} sha256`).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.sha256v2, `${entry.name} sha256v2`).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('exposes a well-formed schema version and timestamp', () => {
    const registry = loadLocalRegistry();
    expect(registry.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(Number.isNaN(Date.parse(registry.updatedAt))).toBe(false);
  });
});
