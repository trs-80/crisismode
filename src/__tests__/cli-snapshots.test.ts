// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  configure, printHealthStatus, printScanSummary, escalationBadge,
} from '../cli/output.js';
import type { ScanResult } from '../cli/output.js';
import type { HealthAssessment } from '../types/health.js';
import {
  CrisisModeError,
  connectionRefused,
  noConfig,
  missingEnvVar,
  agentNotFound,
  formatError,
} from '../cli/errors.js';

// ── Helpers ──

function captureLog(fn: () => void): string {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls.map(c => c[0]).join('\n');
  } finally {
    spy.mockRestore();
  }
}

function normalizeTimestamps(str: string): string {
  return str.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<<TIMESTAMP>>');
}

// ── Fixtures ──

const scanResult: ScanResult = {
  score: 72,
  findings: [
    {
      id: 'PG-001',
      service: 'postgresql',
      status: 'healthy',
      summary: 'Replication OK',
      confidence: 0.95,
      escalationLevel: 1,
      signals: [{ status: 'healthy', detail: 'lag < 1s' }],
    },
    {
      id: 'REDIS-001',
      service: 'redis',
      status: 'unhealthy',
      summary: 'Memory pressure detected',
      confidence: 0.8,
      escalationLevel: 4,
      signals: [{ status: 'critical', detail: 'used_memory > maxmemory' }],
    },
    {
      id: 'ETCD-001',
      service: 'etcd',
      status: 'recovering',
      summary: 'Leader election in progress',
      confidence: 0.6,
      escalationLevel: 2,
      signals: [{ status: 'warning', detail: 'raft term changed' }],
    },
  ],
  scannedAt: '2026-01-15T12:00:00.000Z',
  durationMs: 234,
};

const healthAssessment: HealthAssessment = {
  status: 'unhealthy',
  confidence: 0.85,
  summary: 'Replication lag exceeds threshold',
  observedAt: '2026-01-15T12:00:00.000Z',
  signals: [
    { source: 'replication_check', status: 'critical', detail: 'lag at 45s', observedAt: '2026-01-15T12:00:00.000Z' },
    { source: 'connection_pool', status: 'healthy', detail: 'pool utilization 30%', observedAt: '2026-01-15T12:00:00.000Z' },
    { source: 'disk_usage', status: 'warning', detail: 'WAL directory 78% full', observedAt: '2026-01-15T12:00:00.000Z' },
  ],
  recommendedActions: ['Investigate replica lag', 'Check WAL archiving'],
};

// ── Tests ──

describe('CLI snapshot — scan pipe mode', () => {
  beforeEach(() => configure({ mode: 'pipe', noColor: true }));
  afterEach(() => configure({ json: false, noColor: false, verbose: false, mode: 'human' }));

  it('scan summary in pipe mode', () => {
    const output = captureLog(() => printScanSummary(scanResult));
    const normalized = normalizeTimestamps(output);
    expect(normalized).toMatchSnapshot();
  });
});

describe('CLI snapshot — scan JSON mode', () => {
  beforeEach(() => configure({ json: true, noColor: true }));
  afterEach(() => configure({ json: false, noColor: false, verbose: false, mode: 'human' }));

  it('scan summary in JSON mode', () => {
    const output = captureLog(() => printScanSummary(scanResult));
    const parsed = JSON.parse(output);
    parsed.scannedAt = '<<TIMESTAMP>>';
    expect(parsed).toMatchSnapshot();
  });
});

describe('CLI snapshot — error formatting', () => {
  it('CrisisModeError with suggestion', () => {
    const err = new CrisisModeError('Database connection lost', 'Check pg_hba.conf and restart');
    expect(formatError(err)).toMatchSnapshot();
  });

  it('connectionRefused — postgresql', () => {
    expect(formatError(connectionRefused('postgresql', 'db.local', 5432))).toMatchSnapshot();
  });

  it('connectionRefused — unknown kind', () => {
    expect(formatError(connectionRefused('mysql', 'db.local', 3306))).toMatchSnapshot();
  });

  it('noConfig', () => {
    expect(formatError(noConfig())).toMatchSnapshot();
  });

  it('missingEnvVar', () => {
    expect(formatError(missingEnvVar('PG_PASSWORD', 'database authentication'))).toMatchSnapshot();
  });

  it('agentNotFound', () => {
    expect(formatError(agentNotFound('mysql'))).toMatchSnapshot();
  });

  it('plain Error', () => {
    expect(formatError(new Error('unexpected EOF'))).toMatchSnapshot();
  });

  it('non-Error value', () => {
    expect(formatError(42)).toMatchSnapshot();
  });
});

describe('CLI snapshot — health status JSON', () => {
  beforeEach(() => configure({ json: true, noColor: true }));
  afterEach(() => configure({ json: false, noColor: false, verbose: false, mode: 'human' }));

  it('health assessment in JSON mode', () => {
    const output = captureLog(() => printHealthStatus(healthAssessment));
    const parsed = JSON.parse(output);
    // Normalize timestamps in the assessment
    parsed.assessment.observedAt = '<<TIMESTAMP>>';
    for (const signal of parsed.assessment.signals) {
      signal.observedAt = '<<TIMESTAMP>>';
    }
    expect(parsed).toMatchSnapshot();
  });
});

describe('CLI snapshot — escalation badges', () => {
  beforeEach(() => configure({ noColor: true }));
  afterEach(() => configure({ json: false, noColor: false, verbose: false, mode: 'human' }));

  it('level 1 — Observe', () => {
    expect(escalationBadge(1)).toMatchSnapshot();
  });

  it('level 2 — Diagnose', () => {
    expect(escalationBadge(2)).toMatchSnapshot();
  });

  it('level 3 — Suggest', () => {
    expect(escalationBadge(3)).toMatchSnapshot();
  });

  it('level 4 — Repair', () => {
    expect(escalationBadge(4)).toMatchSnapshot();
  });

  it('level 5 — Repair!', () => {
    expect(escalationBadge(5)).toMatchSnapshot();
  });
});
