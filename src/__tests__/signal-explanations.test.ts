// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { explainSource, enrichHealth, enrichDiagnosis } from '../framework/signal-explanations.js';
import type { DiagnosisResult, HealthAssessment } from '../types/index.js';

describe('explainSource', () => {
  it('explains replication signals with a postgresql.org link', () => {
    const e = explainSource('pg_replication');
    expect(e?.explanation).toMatch(/standby|replica/i);
    expect(e?.learnMoreUrl).toContain('postgresql.org');
  });

  it('explains dns, tls, disk, redis, etcd, kafka, and environment_check sources', () => {
    for (const src of ['dns', 'tls_certificate', 'disk', 'redis_memory', 'etcd_consensus', 'kafka_broker', 'environment_check']) {
      expect(explainSource(src), src).toBeDefined();
      expect(explainSource(src)!.learnMoreUrl).toMatch(/^https:\/\//);
    }
  });

  it('gives kafka leader/partition sources the kafka explanation, not etcd', () => {
    for (const src of ['kafka_leader_election_failed', 'partition_leader_offline']) {
      expect(explainSource(src)?.learnMoreUrl, src).toContain('kafka.apache.org');
    }
  });

  it('still gives etcd leader sources the etcd explanation', () => {
    expect(explainSource('etcd_leader_lost')?.learnMoreUrl).toContain('etcd.io');
  });

  it('gives redis_replication the redis explanation, not postgresql', () => {
    expect(explainSource('redis_replication')?.learnMoreUrl).toContain('redis.io');
  });

  it('returns undefined for unknown sources', () => {
    expect(explainSource('bogus_source_xyz')).toBeUndefined();
  });
});

describe('enrichment', () => {
  it('fills explanation fields without overwriting existing ones', () => {
    const health: HealthAssessment = {
      status: 'unhealthy', confidence: 1, summary: '', observedAt: 'x',
      recommendedActions: [],
      signals: [
        { source: 'pg_replication', status: 'critical', detail: 'lag 45s', observedAt: 'x' },
        { source: 'custom', status: 'warning', detail: 'x', observedAt: 'x', explanation: 'mine', learnMoreUrl: 'https://example.com' },
      ],
    };
    const out = enrichHealth(health);
    expect(out.signals[0].explanation).toBeTruthy();
    expect(out.signals[0].learnMoreUrl).toContain('postgresql.org');
    expect(out.signals[1].explanation).toBe('mine');
  });

  it('enriches diagnosis findings', () => {
    const d: DiagnosisResult = {
      status: 'identified', scenario: 'x', confidence: 1, diagnosticPlanNeeded: false,
      findings: [{ source: 'dns_resolvers', observation: 'o', severity: 'critical' }],
    };
    expect(enrichDiagnosis(d).findings[0].learnMoreUrl).toMatch(/^https:\/\//);
  });
});
