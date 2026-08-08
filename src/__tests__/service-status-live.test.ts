// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Live catalog validation — hits the real internet, so it never runs as part
 * of the default suite. Every catalog entry's `statusUrl` must return a body
 * `parseStatuspageSummary` can classify, and `probeHost` must at least be
 * DNS-resolvable. Gated on CRISISMODE_LIVE_TESTS: `pnpm test` (no env var)
 * must never depend on network access or a provider's status page being up.
 *
 * This is the honesty backstop for `SERVICE_CATALOG` (catalog.ts): every
 * entry is a "candidate" until it has passed here at least once. Failures
 * drive corrections to the catalog (Task 9), not to this suite.
 */

import { describe, it, expect } from 'vitest';
import { lookup } from 'node:dns/promises';
import { SERVICE_CATALOG } from '../framework/service-status/catalog.js';
import { parseStatuspageSummary } from '../framework/service-status/statuspage.js';
import { probeTcpBounded } from '../framework/triage-probes.js';

const STATUS_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 10_000;

/** Mirrors checker.ts's `defaultProbe`: DNS lookup, then a bounded TCP connect. */
async function probe(host: string, port: number): Promise<'reachable' | 'dns_failed' | 'connect_failed'> {
  try {
    await lookup(host);
  } catch {
    return 'dns_failed';
  }
  const result = await probeTcpBounded(host, port, host, PROBE_TIMEOUT_MS);
  return result.reachable ? 'reachable' : 'connect_failed';
}

describe.skipIf(!process.env.CRISISMODE_LIVE_TESTS)('catalog live validation', () => {
  for (const entry of SERVICE_CATALOG) {
    it(`${entry.id}: statusUrl returns a parseable Statuspage v2 summary`, async () => {
      const response = await fetch(entry.statusUrl, {
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      expect(response.ok).toBe(true);
      const body: unknown = await response.json();
      expect(parseStatuspageSummary(body)).not.toBeNull();
    });

    it(`${entry.id}: probeHost (${entry.probeHost}) is DNS-resolvable`, async () => {
      const outcome = await probe(entry.probeHost, entry.probePort);
      expect(outcome).not.toBe('dns_failed');
    });
  }
});
