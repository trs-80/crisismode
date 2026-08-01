// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { printScanSummary, setOutputOptions } from '../cli/output.js';
import type { ScanResult } from '../cli/output.js';

function fixtureResult(): ScanResult {
  return {
    score: 40,
    findings: [{
      id: 'PG-001',
      service: 'postgresql (default-postgres)',
      status: 'unhealthy',
      summary: 'Replication lag exceeds threshold',
      confidence: 0.9,
      escalationLevel: 2,
      signals: [{ status: 'critical', detail: 'lag 45m', source: 'pg_replication_lag' }],
      explanation: 'PostgreSQL replication keeps a standby copy of the database in sync.',
      learnMoreUrl: 'https://www.postgresql.org/docs/current/warm-standby.html',
    }],
    recentChanges: [],
    scannedAt: '2026-08-01T00:00:00.000Z',
    durationMs: 100,
  } as unknown as ScanResult;
}

describe('scan explanation rendering', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    setOutputOptions({ mode: 'human', terse: false });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setOutputOptions({ mode: 'human', terse: false });
  });

  it('prints the explanation and learn-more line under a non-healthy finding', () => {
    printScanSummary(fixtureResult());
    const text = lines.join('\n');
    expect(text).toContain('standby copy');
    expect(text).toContain('postgresql.org');
  });

  it('suppresses explanations when terse', () => {
    setOutputOptions({ terse: true });
    printScanSummary(fixtureResult());
    const text = lines.join('\n');
    expect(text).not.toContain('standby copy');
    expect(text).toContain('Replication lag exceeds threshold'); // finding line intact
  });
});
