// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `printIncidentSummary` — the human-mode renderer.
 *
 * `formatIncidentSummaryText` (the pipe/paste form) is covered in
 * incident-summary.test.ts; this is its terminal counterpart, and the two must
 * not drift apart. It is the surface an operator actually reads at the end of a
 * scan, including the `crisismode diagnose <target>` line whose correctness
 * `diagnoseCommandFor` exists to guarantee — a suggestion printed here that
 * does not resolve is a dead end mid-incident.
 *
 * Assertions are on content, not colour: chalk emits no ANSI when stdout is not
 * a TTY, which is the case under vitest, so a colour assertion would pass
 * vacuously.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildIncidentSummary,
  printIncidentSummary,
} from '../cli/incident-summary.js';
import type { ScanResult } from '../cli/output.js';

function makeFinding(
  overrides: Partial<ScanResult['findings'][0]> = {},
): ScanResult['findings'][0] {
  return {
    id: 'TEST-001',
    service: 'test-service',
    status: 'healthy',
    summary: 'All good',
    confidence: 0.9,
    escalationLevel: 1,
    signals: [],
    ...overrides,
  };
}

function makeResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    score: 100,
    findings: [],
    recentChanges: [],
    scannedAt: '2026-08-09T12:00:00Z',
    durationMs: 1500,
    ...overrides,
  };
}

/** Print a summary and return everything it wrote as one string. */
function capturePrinted(result: ScanResult): string {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    printIncidentSummary(buildIncidentSummary(result));
  } finally {
    logSpy.mockRestore();
  }
  return lines.join('\n');
}

describe('printIncidentSummary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints every section when all three severities are present', () => {
    const out = capturePrinted(
      makeResult({
        score: 42,
        findings: [
          makeFinding({
            id: 'PG-001',
            service: 'postgresql (prod-db)',
            status: 'unhealthy',
            summary: 'Replication lag 342s',
          }),
          makeFinding({
            id: 'REDIS-001',
            service: 'redis (cache-01)',
            status: 'recovering',
            summary: 'Memory pressure easing',
          }),
          makeFinding({ id: 'DNS-001', service: 'dns (resolver)', status: 'healthy' }),
        ],
      }),
    );

    expect(out).toContain('Incident Summary (paste into Slack/incident channel)');
    expect(out).toContain('Time: 2026-08-09T12:00:00Z');
    expect(out).toContain('Scan completed in 1.5s');

    // Headline: critical wins over warning.
    expect(out).toContain('1 service unhealthy out of 3 checked (score: 42/100)');

    expect(out).toContain('UNHEALTHY:');
    expect(out).toContain('[PG-001] postgresql (prod-db) — Replication lag 342s');
    expect(out).toContain('NEEDS ATTENTION:');
    expect(out).toContain('[REDIS-001] redis (cache-01) — Memory pressure easing');
    expect(out).toContain('OK: dns (resolver)');

    // The next step must name the target, not the finding id.
    expect(out).toContain('NEXT STEPS:');
    expect(out).toContain('crisismode diagnose prod-db');
    expect(out).not.toContain('crisismode diagnose PG-001');
  });

  it('omits the sections that have no findings', () => {
    const out = capturePrinted(
      makeResult({
        findings: [makeFinding({ id: 'PG-001', service: 'postgresql (prod-db)' })],
      }),
    );

    expect(out).toContain('All 1 services healthy (score: 100/100)');
    expect(out).toContain('OK: postgresql (prod-db)');
    expect(out).not.toContain('UNHEALTHY:');
    expect(out).not.toContain('NEEDS ATTENTION:');
    expect(out).toContain('All systems healthy. Monitor with: `crisismode watch`');
  });

  it('leads with the warning headline when nothing is unhealthy', () => {
    const out = capturePrinted(
      makeResult({
        score: 70,
        findings: [
          makeFinding({ id: 'PG-001', status: 'unknown', summary: 'Unreachable' }),
          makeFinding({ id: 'REDIS-001', status: 'unknown', summary: 'Timeout' }),
        ],
      }),
    );

    expect(out).toContain('2 services need attention out of 2 checked (score: 70/100)');
    expect(out).toContain('NEEDS ATTENTION:');
    expect(out).not.toContain('UNHEALTHY:');
    expect(out).not.toContain('OK:');
    expect(out).toContain('crisismode scan --verbose');
  });

  it('prints nothing but the frame when there are no findings at all', () => {
    const out = capturePrinted(makeResult());

    expect(out).toContain('All 0 services healthy (score: 100/100)');
    expect(out).not.toContain('UNHEALTHY:');
    expect(out).not.toContain('NEEDS ATTENTION:');
    expect(out).not.toContain('OK:');
    // No findings means no actionable next step to invent.
    expect(out).not.toContain('NEXT STEPS:');
  });

  it('emits no ANSI escapes under a non-TTY stdout', () => {
    const out = capturePrinted(
      makeResult({ findings: [makeFinding({ id: 'PG-001', status: 'unhealthy' })] }),
    );

    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[/);
  });
});
