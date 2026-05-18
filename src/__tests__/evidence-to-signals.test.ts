// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';

import { evidenceItemsToSignals } from '../framework/evidence-to-signals.js';
import type { EvidenceItem } from '../types/evidence-bundle.js';

function evi(overrides: Partial<EvidenceItem>): EvidenceItem {
  return {
    evidence_id: 'ev-1',
    adapter_id: 'service.logs',
    title: 'logs',
    source_kind: 'log',
    content_type: 'log_excerpt',
    content: { format: 'log_excerpt', body: 'hello' },
    redacted: true,
    untrusted: false,
    ...overrides,
  };
}

describe('evidenceItemsToSignals — type inference', () => {
  it('database pool saturation → connection (so router picks postgresql)', () => {
    const [s] = evidenceItemsToSignals([
      evi({
        adapter_id: 'database.pool_status',
        title: 'Pool saturated',
        content: { format: 'metric_series', body: 'active=95 max=100' },
      }),
    ]);
    expect(s.type).toBe('connection');
    expect(s.source).toBe('database');
  });

  it('redis memory pressure → resource_exhaustion', () => {
    const [s] = evidenceItemsToSignals([
      evi({
        adapter_id: 'redis.memory_stats',
        title: 'Memory pressure',
        content: { format: 'metric_series', body: 'maxmemory reached, evictions=1200' },
      }),
    ]);
    expect(s.type).toBe('resource_exhaustion');
  });

  it('postgres replication lag → latency', () => {
    const [s] = evidenceItemsToSignals([
      evi({
        adapter_id: 'database.replication_status',
        title: 'Replication lag',
        content: { format: 'metric_series', body: 'replica lag 636s' },
      }),
    ]);
    expect(s.type).toBe('latency');
  });

  it('service 503 errors → error_rate', () => {
    const [s] = evidenceItemsToSignals([
      evi({
        adapter_id: 'service.logs',
        title: 'Errors',
        content: { format: 'log_excerpt', body: 'checkout-api 503 errors' },
      }),
    ]);
    expect(s.type).toBe('error_rate');
  });

  it('kafka consumer lag → queue_depth', () => {
    const [s] = evidenceItemsToSignals([
      evi({
        adapter_id: 'kafka.consumer_group_state',
        title: 'Consumer lag',
        content: { format: 'metric_series', body: 'consumer_lag=120000' },
      }),
    ]);
    expect(s.type).toBe('queue_depth');
  });

  it('config drift → config_mismatch', () => {
    const [s] = evidenceItemsToSignals([
      evi({
        adapter_id: 'config.env_diff',
        title: 'Config drift detected',
        content: { format: 'text', body: 'env var DATABASE_URL mismatch between pods' },
      }),
    ]);
    expect(s.type).toBe('config_mismatch');
  });

  it('deploy rollback → deploy_change', () => {
    const [s] = evidenceItemsToSignals([
      evi({
        adapter_id: 'deploy.history',
        title: 'Recent deploys',
        content: { format: 'text', body: 'new release v4.2 deployed 10 min ago' },
      }),
    ]);
    expect(s.type).toBe('deploy_change');
  });

  it('connection refused → connection', () => {
    const [s] = evidenceItemsToSignals([
      evi({
        adapter_id: 'service.endpoint_probe',
        title: 'Endpoint check',
        content: { format: 'text', body: 'connection refused on port 5432' },
      }),
    ]);
    expect(s.type).toBe('connection');
  });

  it('timeouts → timeout', () => {
    const [s] = evidenceItemsToSignals([
      evi({
        adapter_id: 'service.endpoint_probe',
        title: 'Probe',
        content: { format: 'text', body: 'request hanging — timed out after 30s' },
      }),
    ]);
    expect(s.type).toBe('timeout');
  });

  it('crash loop → error_rate', () => {
    const [s] = evidenceItemsToSignals([
      evi({
        adapter_id: 'kubernetes.pod_state',
        title: 'Pod state',
        content: { format: 'text', body: 'pod foo CrashLoopBackOff' },
      }),
    ]);
    expect(s.type).toBe('error_rate');
  });

  it('unclassifiable → custom', () => {
    const [s] = evidenceItemsToSignals([
      evi({
        adapter_id: 'operator.note',
        title: 'A note',
        content: { format: 'text', body: 'something is happening but unclear what' },
      }),
    ]);
    expect(s.type).toBe('custom');
  });
});

describe('evidenceItemsToSignals — severity', () => {
  it('critical keywords escalate to critical', () => {
    const [s] = evidenceItemsToSignals([
      evi({
        adapter_id: 'service.logs',
        title: 'OOM kill',
        content: { format: 'log_excerpt', body: 'oom-killer terminated checkout-api' },
      }),
    ]);
    expect(s.severity).toBe('critical');
  });

  it('untrusted evidence is downgraded to info', () => {
    const [s] = evidenceItemsToSignals([
      evi({
        adapter_id: 'database.pool_status',
        title: 'Pool saturated',
        untrusted: true,
        content: { format: 'metric_series', body: 'active=95 max=100' },
      }),
    ]);
    expect(s.severity).toBe('info');
  });

  it('operator notes default to info', () => {
    const [s] = evidenceItemsToSignals([
      evi({
        adapter_id: 'operator.note',
        source_kind: 'operator_note',
        title: 'note',
        content: { format: 'text', body: 'thought this might be a db issue' },
      }),
    ]);
    expect(s.severity).toBe('info');
  });

  it('default for typical evidence is warning', () => {
    const [s] = evidenceItemsToSignals([
      evi({
        adapter_id: 'database.pool_status',
        title: 'Pool',
        content: { format: 'metric_series', body: 'active=70 max=100' },
      }),
    ]);
    expect(s.severity).toBe('warning');
  });
});

describe('evidenceItemsToSignals — data preservation', () => {
  it('preserves evidence_id, adapter_id, source_kind, content_type', () => {
    const [s] = evidenceItemsToSignals([
      evi({
        evidence_id: 'my-ev',
        adapter_id: 'kafka.consumer_group_state',
        source_kind: 'metric',
        content_type: 'metric_series',
      }),
    ]);
    expect(s.data).toEqual({
      evidence_id: 'my-ev',
      adapter_id: 'kafka.consumer_group_state',
      source_kind: 'metric',
      content_type: 'metric_series',
    });
  });

  it('produces one signal per evidence item', () => {
    const signals = evidenceItemsToSignals([
      evi({ evidence_id: 'a' }),
      evi({ evidence_id: 'b', adapter_id: 'database.x' }),
      evi({ evidence_id: 'c', adapter_id: 'kafka.x' }),
    ]);
    expect(signals).toHaveLength(3);
    expect(signals.map((s) => s.source)).toEqual(['service', 'database', 'kafka']);
  });
});
