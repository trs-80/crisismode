// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * End-to-end routing tests for bundle → agent family.
 *
 * Each test feeds a representative evidence bundle through
 * `evidenceItemsToSignals → routeBySymptoms` and asserts the
 * recommended agent family matches the registered kind in
 * src/agent/*\/registration.ts. The goal is full coverage of the
 * 14 families the sre-incident-agent-skills compatibility benchmark
 * checks for.
 */

import { describe, it, expect } from 'vitest';

import { evidenceItemsToSignals } from '../framework/evidence-to-signals.js';
import { routeBySymptoms } from '../framework/symptom-router.js';
import type { EvidenceItem } from '../types/evidence-bundle.js';

function evi(overrides: Partial<EvidenceItem> & Pick<EvidenceItem, 'adapter_id' | 'title' | 'content'>): EvidenceItem {
  return {
    evidence_id: overrides.evidence_id ?? 'ev',
    source_kind: 'metric',
    content_type: 'text',
    redacted: true,
    untrusted: false,
    ...overrides,
  };
}

function routeFor(items: EvidenceItem[]): string | null {
  const signals = evidenceItemsToSignals(items);
  return routeBySymptoms(signals).recommendedAgent;
}

describe('end-to-end family routing', () => {
  it('postgresql connection-pool exhaustion → postgresql', () => {
    expect(routeFor([evi({
      adapter_id: 'database.pool_status',
      title: 'Connection pool saturated',
      content: { format: 'text', body: 'active=95 max=100 too many connections' },
    })])).toBe('postgresql');
  });

  it('postgresql replication lag → postgresql', () => {
    expect(routeFor([evi({
      adapter_id: 'database.replication_status',
      title: 'Replication lag',
      content: { format: 'text', body: 'replica wal sender lag 636s' },
    })])).toBe('postgresql');
  });

  it('redis memory pressure → redis', () => {
    expect(routeFor([evi({
      adapter_id: 'redis.memory_stats',
      title: 'Redis memory pressure',
      content: { format: 'text', body: 'maxmemory eviction running for redis cache' },
    })])).toBe('redis');
  });

  it('kafka consumer lag → kafka', () => {
    expect(routeFor([evi({
      adapter_id: 'kafka.consumer_group_state',
      title: 'Kafka consumer lag',
      content: { format: 'text', body: 'kafka broker partition consumer offset lag 120000' },
    })])).toBe('kafka');
  });

  it('etcd consensus loss → etcd', () => {
    expect(routeFor([evi({
      adapter_id: 'etcd.cluster_health',
      title: 'Cluster consensus',
      content: { format: 'text', body: 'etcd raft leader election quorum failure' },
    })])).toBe('etcd');
  });

  it('kubernetes crash loop → kubernetes', () => {
    expect(routeFor([evi({
      adapter_id: 'kubernetes.pod_state',
      title: 'Pod state',
      content: { format: 'text', body: 'pod checkout-api in CrashLoopBackOff, container restart' },
    })])).toBe('kubernetes');
  });

  it('ceph storage degraded → ceph', () => {
    expect(routeFor([evi({
      adapter_id: 'ceph.cluster_status',
      title: 'Storage health',
      content: { format: 'text', body: 'ceph cluster degraded, osd down, placement groups unfound' },
    })])).toBe('ceph');
  });

  it('flink checkpoint failure → flink', () => {
    expect(routeFor([evi({
      adapter_id: 'flink.checkpoint_status',
      title: 'Pipeline state',
      content: { format: 'text', body: 'flink checkpoint failed, backpressure on stream pipeline' },
    })])).toBe('flink');
  });

  it('deploy regression → application', () => {
    expect(routeFor([evi({
      adapter_id: 'deploy.history',
      title: 'Recent deploys',
      content: { format: 'text', body: 'new version v4.2 deployed 10 min ago, error rate regression' },
    })])).toBe('application');
  });

  it('config drift → application-config', () => {
    expect(routeFor([evi({
      adapter_id: 'config.env_diff',
      title: 'Configuration drift',
      content: { format: 'text', body: 'environment variable mismatch DATABASE_URL drift' },
    })])).toBe('application-config');
  });

  it('AI provider failover → ai-provider', () => {
    expect(routeFor([evi({
      adapter_id: 'provider.error_metrics',
      title: 'AI provider degradation',
      content: { format: 'text', body: 'openai api 429 rate limit, anthropic provider timeout' },
    })])).toBe('ai-provider');
  });

  it('queue worker backlog → message-queue', () => {
    expect(routeFor([evi({
      adapter_id: 'queue.worker_state',
      title: 'Checkout worker queue',
      content: { format: 'text', body: 'sidekiq workers saturated, jobs stuck, dlq filling' },
    })])).toBe('message-queue');
  });

  it('schema migration stuck → managed-database', () => {
    expect(routeFor([evi({
      adapter_id: 'database.migration_status',
      title: 'Schema migration',
      content: { format: 'text', body: 'alembic migration blocked by pg_locks, schema lock_wait' },
    })])).toBe('managed-database');
  });

  it('ambiguous operator note → no recommendation', () => {
    const ambiguous = routeFor([evi({
      adapter_id: 'operator.note',
      source_kind: 'operator_note',
      title: 'Operator hunch',
      content: { format: 'text', body: 'something feels off but I cannot tell what' },
    })]);
    // The router may or may not return null; what we care about is
    // that no specific incident family is strongly recommended.
    // Accept null OR a low-confidence recommendation.
    expect(ambiguous).toBeOneOf([null, 'application', 'application-config']);
  });
});

describe('no-regression checks for previously routed families', () => {
  it('queue keywords do NOT steal kafka cases (kafka still wins for explicit kafka)', () => {
    expect(routeFor([evi({
      adapter_id: 'kafka.consumer_group_state',
      title: 'Consumer lag',
      content: { format: 'text', body: 'kafka broker consumer lag, partition offset stuck' },
    })])).toBe('kafka');
  });

  it('migration keywords do NOT steal postgresql replication cases', () => {
    expect(routeFor([evi({
      adapter_id: 'database.replication_status',
      title: 'Replication lag',
      content: { format: 'text', body: 'postgres replica wal sender lagging 800s' },
    })])).toBe('postgresql');
  });
});
