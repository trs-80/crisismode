// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { buildScanEvidence } from '../cli/commands/scan.js';
import { synthesizeByRules } from '../framework/root-cause-synthesis.js';
import type { HealthAssessment } from '../types/health.js';

describe('buildScanEvidence (Task B2 follow-up)', () => {
  it('emits signals-only connection evidence for a hard-down catch-path target, ' +
    'and clusters it with an unhealthy target via component-failure-cascade', () => {
    const results = [
      {
        kind: 'postgresql',
        health: null,
        finding: { service: 'postgresql (pg-primary)', summary: 'Error: connect ECONNREFUSED 127.0.0.1:5432' },
      },
      {
        kind: 'redis',
        health: {
          status: 'unhealthy',
          confidence: 0.9,
          summary: 'Memory pressure critical',
          observedAt: new Date().toISOString(),
          signals: [
            { source: 'redis', status: 'critical', detail: 'memory usage at 98%, evicting keys', observedAt: new Date().toISOString() },
          ],
          recommendedActions: [],
        } as HealthAssessment,
        finding: { service: 'redis (redis-cache)', summary: 'Memory pressure critical' },
      },
    ];

    const evidence = buildScanEvidence(results);
    expect(evidence).toHaveLength(2);

    const pgEvidence = evidence.find((e) => e.agentKind === 'postgresql');
    expect(pgEvidence).toBeDefined();
    expect(pgEvidence?.health).toBeUndefined();
    expect(pgEvidence?.signals).toEqual([
      {
        type: 'connection',
        source: 'postgresql_connection',
        detail: 'Error: connect ECONNREFUSED 127.0.0.1:5432',
        severity: 'critical',
      },
    ]);

    const redisEvidence = evidence.find((e) => e.agentKind === 'redis');
    expect(redisEvidence).toBeDefined();
    expect(redisEvidence?.health).toBeDefined();

    const synthesis = synthesizeByRules(evidence);
    expect(synthesis.clusters.length).toBeGreaterThanOrEqual(1);

    const cluster = synthesis.clusters.find(
      (c) => c.agents.includes('postgresql') && c.agents.includes('redis'),
    );
    expect(cluster).toBeDefined();
    expect(cluster?.reasoning).toContain('component-failure-cascade');

    const pgIdx = cluster!.investigationOrder.indexOf('postgresql');
    const redisIdx = cluster!.investigationOrder.indexOf('redis');
    expect(pgIdx).toBeGreaterThanOrEqual(0);
    expect(redisIdx).toBeGreaterThanOrEqual(0);
    expect(pgIdx).toBeLessThan(redisIdx);
  });

  it('returns empty evidence for healthy-only results, so no synthesis is triggered', () => {
    const results = [
      {
        kind: 'postgresql',
        health: {
          status: 'healthy',
          confidence: 0.95,
          summary: 'All good',
          observedAt: new Date().toISOString(),
          signals: [],
          recommendedActions: [],
        } as HealthAssessment,
        finding: { service: 'postgresql (pg-primary)', summary: 'All good' },
      },
      {
        kind: 'redis',
        health: {
          status: 'unknown',
          confidence: 0,
          summary: 'Health check timed out',
          observedAt: new Date().toISOString(),
          signals: [],
          recommendedActions: [],
        } as HealthAssessment,
        finding: { service: 'redis (redis-cache)', summary: 'Health check timed out' },
      },
    ];

    const evidence = buildScanEvidence(results);
    expect(evidence).toHaveLength(0);
  });

  it('preserves existing behavior: unhealthy targets with real health objects still produce full evidence', () => {
    const makeUnhealthy = (): HealthAssessment => ({
      status: 'unhealthy',
      confidence: 0.85,
      summary: 'Degraded',
      observedAt: new Date().toISOString(),
      signals: [
        { source: 'agent', status: 'critical', detail: 'connection timeouts spiking', observedAt: new Date().toISOString() },
      ],
      recommendedActions: [],
    });

    const results = [
      {
        kind: 'postgresql',
        health: makeUnhealthy(),
        finding: { service: 'postgresql (pg-primary)', summary: 'Degraded' },
      },
      {
        kind: 'redis',
        health: makeUnhealthy(),
        finding: { service: 'redis (redis-cache)', summary: 'Degraded' },
      },
    ];

    const evidence = buildScanEvidence(results);
    expect(evidence).toHaveLength(2);
    for (const e of evidence) {
      expect(e.health).toBeDefined();
      expect(e.health?.status).toBe('unhealthy');
      expect(e.signals).toBeDefined();
    }
  });
});
