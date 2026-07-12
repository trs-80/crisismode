// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { healthToSignals } from '../framework/health-to-signals.js';
import type { HealthAssessment } from '../types/health.js';

function health(signals: Array<{ source: string; status: 'critical' | 'warning'; detail: string }>): HealthAssessment {
  return {
    status: 'unhealthy',
    confidence: 0.9,
    summary: 'test',
    observedAt: '2026-07-12T00:00:00Z',
    signals: signals.map((s) => ({ ...s, observedAt: '2026-07-12T00:00:00Z' })),
    recommendedActions: [],
  };
}

describe('healthToSignals', () => {
  it('maps unreachable/refused details to connection signals', () => {
    const out = healthToSignals(health([
      { source: 'pg_connection', status: 'critical', detail: 'PostgreSQL is unreachable: ECONNREFUSED' },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('connection');
    expect(out[0].severity).toBe('critical');
  });

  it('maps timeouts, lag, and memory details to matching types', () => {
    const out = healthToSignals(health([
      { source: 'probe', status: 'warning', detail: 'health check timed out' },
      { source: 'pg_replication', status: 'critical', detail: 'replication lag 45s' },
      { source: 'redis_memory', status: 'critical', detail: 'memory 95% used, noeviction' },
    ]));
    expect(out.map((s) => s.type)).toEqual(['timeout', 'latency', 'resource_exhaustion']);
  });

  it('maps 5xx and failure details to error_rate signals', () => {
    const out = healthToSignals(health([
      { source: 'http_probe', status: 'critical', detail: 'upstream returning 502 responses' },
      { source: 'job_runner', status: 'warning', detail: 'nightly job failed twice' },
    ]));
    expect(out.map((s) => s.type)).toEqual(['error_rate', 'error_rate']);
  });

  it('maps "connection timed out" to timeout, not connection', () => {
    const out = healthToSignals(health([
      { source: 'pg_probe', status: 'critical', detail: 'connection timed out after 5s' },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('timeout');
  });

  it('does not map bare port numbers like 5432 to error_rate', () => {
    const out = healthToSignals(health([
      { source: 'netstat', status: 'warning', detail: 'process listening on port 5432' },
    ]));
    expect(out.filter((s) => s.type === 'error_rate')).toHaveLength(0);
    expect(out).toHaveLength(0);
  });

  it('does not map "fully" to resource_exhaustion (word boundary on "full")', () => {
    const out = healthToSignals(health([
      { source: 'pg_replication', status: 'critical', detail: 'replica fully synced but read-only' },
    ]));
    expect(out).toHaveLength(0);
  });

  it('drops healthy signals', () => {
    const a = health([]);
    a.signals.push({ source: 'ok', status: 'healthy', detail: 'fine', observedAt: '2026-07-12T00:00:00Z' });
    expect(healthToSignals(a)).toHaveLength(0);
  });
});
