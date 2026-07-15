// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import {
  buildIncidentSummary,
  formatIncidentSummaryText,
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

function makeResult(
  overrides: Partial<ScanResult> = {},
): ScanResult {
  return {
    score: 100,
    findings: [],
    recentChanges: [],
    scannedAt: '2026-04-04T00:00:00Z',
    durationMs: 150,
    ...overrides,
  };
}

describe('buildIncidentSummary', () => {
  it('handles zero findings', () => {
    const summary = buildIncidentSummary(makeResult());

    expect(summary.critical).toHaveLength(0);
    expect(summary.warning).toHaveLength(0);
    expect(summary.healthy).toHaveLength(0);
    expect(summary.headline).toContain('All 0 services healthy');
    expect(summary.nextSteps).toHaveLength(0);
  });

  it('handles all healthy findings', () => {
    const result = makeResult({
      findings: [
        makeFinding({ id: 'PG-001', service: 'postgresql' }),
        makeFinding({ id: 'REDIS-001', service: 'redis' }),
      ],
    });

    const summary = buildIncidentSummary(result);

    expect(summary.critical).toHaveLength(0);
    expect(summary.warning).toHaveLength(0);
    expect(summary.healthy).toHaveLength(2);
    expect(summary.headline).toContain('All 2 services healthy');
    expect(summary.nextSteps).toEqual([
      'All systems healthy. Monitor with: `crisismode watch`',
    ]);
  });

  it('groups unhealthy findings as critical', () => {
    const result = makeResult({
      score: 50,
      findings: [
        makeFinding({ id: 'PG-001', service: 'postgresql', status: 'unhealthy', summary: 'Replication lag' }),
        makeFinding({ id: 'REDIS-001', service: 'redis', status: 'healthy' }),
      ],
    });

    const summary = buildIncidentSummary(result);

    expect(summary.critical).toHaveLength(1);
    expect(summary.critical[0]!.id).toBe('PG-001');
    expect(summary.healthy).toHaveLength(1);
    expect(summary.headline).toContain('1 service unhealthy');
    expect(summary.nextSteps[0]).toContain('crisismode diagnose PG-001');
  });

  it('groups recovering and unknown as warning', () => {
    const result = makeResult({
      score: 60,
      findings: [
        makeFinding({ id: 'PG-001', status: 'recovering', summary: 'Catching up' }),
        makeFinding({ id: 'REDIS-001', status: 'unknown', summary: 'Unreachable' }),
      ],
    });

    const summary = buildIncidentSummary(result);

    expect(summary.critical).toHaveLength(0);
    expect(summary.warning).toHaveLength(2);
    expect(summary.headline).toContain('2 services need attention');
  });

  it('suggests diagnose for multiple unhealthy services', () => {
    const result = makeResult({
      score: 0,
      findings: [
        makeFinding({ id: 'PG-001', status: 'unhealthy', summary: 'Down' }),
        makeFinding({ id: 'REDIS-001', status: 'unhealthy', summary: 'OOM' }),
      ],
    });

    const summary = buildIncidentSummary(result);

    expect(summary.nextSteps).toHaveLength(3);
    expect(summary.nextSteps[0]).toContain('crisismode diagnose PG-001');
    expect(summary.nextSteps[1]).toContain('1 more unhealthy');
    expect(summary.nextSteps[2]).toContain('crisismode recover');
  });

  it('suggests verbose scan when all warnings are unknown', () => {
    const result = makeResult({
      score: 30,
      findings: [
        makeFinding({ id: 'PG-001', status: 'unknown', summary: 'Unreachable' }),
        makeFinding({ id: 'REDIS-001', status: 'unknown', summary: 'Timeout' }),
      ],
    });

    const summary = buildIncidentSummary(result);

    expect(summary.nextSteps[0]).toContain('crisismode scan --verbose');
  });

  it('suggests watch when warnings include recovering services', () => {
    const result = makeResult({
      score: 60,
      findings: [
        makeFinding({ id: 'PG-001', status: 'recovering', summary: 'Catching up' }),
      ],
    });

    const summary = buildIncidentSummary(result);

    expect(summary.nextSteps[0]).toContain('crisismode watch');
  });

  it('preserves timestamp and duration from scan result', () => {
    const result = makeResult({
      scannedAt: '2026-04-04T12:00:00Z',
      durationMs: 5000,
    });

    const summary = buildIncidentSummary(result);

    expect(summary.timestamp).toBe('2026-04-04T12:00:00Z');
    expect(summary.durationMs).toBe(5000);
  });
});

describe('formatIncidentSummaryText', () => {
  it('produces plain text with no ANSI codes', () => {
    const result = makeResult({
      score: 50,
      findings: [
        makeFinding({ id: 'PG-001', status: 'unhealthy', summary: 'Lag' }),
        makeFinding({ id: 'REDIS-001', status: 'healthy' }),
      ],
    });

    const summary = buildIncidentSummary(result);
    const text = formatIncidentSummaryText(summary);

    // No ANSI escape codes
    expect(text).not.toMatch(/\x1b\[/);
    expect(text).toContain('CrisisMode Scan Summary');
    expect(text).toContain('UNHEALTHY:');
    expect(text).toContain('[PG-001]');
    expect(text).toContain('OK:');
    expect(text).toContain('NEXT STEPS:');
  });

  it('omits sections with no findings', () => {
    const result = makeResult({
      findings: [
        makeFinding({ id: 'PG-001', status: 'healthy' }),
      ],
    });

    const summary = buildIncidentSummary(result);
    const text = formatIncidentSummaryText(summary);

    expect(text).not.toContain('UNHEALTHY:');
    expect(text).not.toContain('NEEDS ATTENTION:');
    expect(text).toContain('OK:');
  });

  it('formats duration in seconds', () => {
    const result = makeResult({ durationMs: 2500 });
    const summary = buildIncidentSummary(result);
    const text = formatIncidentSummaryText(summary);

    expect(text).toContain('2.5s');
  });

  it('formats duration in minutes for long scans', () => {
    const result = makeResult({ durationMs: 125_000 });
    const summary = buildIncidentSummary(result);
    const text = formatIncidentSummaryText(summary);

    expect(text).toContain('2m 5s');
  });
});
