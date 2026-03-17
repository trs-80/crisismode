// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  configure, getOutputMode, printHealthStatus, printDiagnosis, printStatus,
  printError, printScanSummary, escalationBadge, printNextAction,
} from '../cli/output.js';
import type { ScanResult } from '../cli/output.js';
import type { HealthAssessment } from '../types/health.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';

describe('CLI output — JSON mode', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configure({ json: true, noColor: true, verbose: false });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false });
  });

  it('printHealthStatus outputs valid JSON', () => {
    const health: HealthAssessment = {
      status: 'healthy',
      confidence: 0.95,
      summary: 'All systems operational',
      observedAt: new Date().toISOString(),
      signals: [],
      recommendedActions: [],
    };

    printHealthStatus(health);

    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.type).toBe('health');
    expect(parsed.assessment.status).toBe('healthy');
  });

  it('printDiagnosis outputs valid JSON', () => {
    const diagnosis: DiagnosisResult = {
      status: 'identified',
      scenario: 'replication_lag',
      confidence: 0.85,
      findings: [
        { source: 'replication_check', observation: 'lag at 45s', severity: 'critical' },
      ],
      diagnosticPlanNeeded: false,
    };

    printDiagnosis(diagnosis);

    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.type).toBe('diagnosis');
    expect(parsed.diagnosis.scenario).toBe('replication_lag');
  });

  it('printStatus outputs valid JSON', () => {
    const services = [
      { kind: 'postgresql', host: 'localhost', port: 5432, status: 'up' as const },
      { kind: 'redis', host: 'localhost', port: 6379, status: 'down' as const },
    ];

    printStatus(services);

    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.type).toBe('status');
    expect(parsed.services).toHaveLength(2);
  });

  it('printError outputs valid JSON', () => {
    printError('something failed');

    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.type).toBe('error');
    expect(parsed.message).toBe('something failed');
  });

  it('printScanSummary outputs valid JSON in machine mode', () => {
    const result: ScanResult = {
      score: 85,
      findings: [
        {
          id: 'PG-001',
          service: 'postgresql (detected-postgresql)',
          status: 'healthy',
          summary: 'All systems operational',
          confidence: 0.95,
          escalationLevel: 1,
          signals: [],
        },
      ],
      scannedAt: '2026-03-17T00:00:00Z',
      durationMs: 150,
    };

    printScanSummary(result);

    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.type).toBe('scan');
    expect(parsed.score).toBe(85);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].id).toBe('PG-001');
  });
});

describe('CLI output — output modes', () => {
  afterEach(() => {
    configure({ json: false, noColor: false, verbose: false });
  });

  it('json flag sets machine mode', () => {
    configure({ json: true });
    expect(getOutputMode()).toBe('machine');
  });

  it('explicit mode overrides auto-detection', () => {
    configure({ mode: 'pipe' });
    expect(getOutputMode()).toBe('pipe');
  });

  it('explicit machine mode sets json compat flag', () => {
    configure({ mode: 'machine' });
    expect(getOutputMode()).toBe('machine');
  });
});

describe('CLI output — pipe mode', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configure({ mode: 'pipe', noColor: true });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    configure({ json: false, noColor: false, verbose: false });
  });

  it('printScanSummary outputs tab-separated lines in pipe mode', () => {
    const result: ScanResult = {
      score: 100,
      findings: [
        {
          id: 'REDIS-001',
          service: 'redis',
          status: 'healthy',
          summary: 'OK',
          confidence: 0.9,
          escalationLevel: 1,
          signals: [],
        },
      ],
      scannedAt: '2026-03-17T00:00:00Z',
      durationMs: 50,
    };

    printScanSummary(result);

    // First line: summary, second line: finding
    expect(logSpy.mock.calls[0][0]).toContain('scan\t100');
    expect(logSpy.mock.calls[1][0]).toContain('finding\tREDIS-001');
  });

  it('printNextAction is suppressed in pipe mode', () => {
    printNextAction('Run crisismode diagnose PG-001');
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('CLI output — escalation badges', () => {
  it('returns a string for each level', () => {
    for (const level of [1, 2, 3, 4, 5] as const) {
      const badge = escalationBadge(level);
      expect(typeof badge).toBe('string');
      expect(badge.length).toBeGreaterThan(0);
    }
  });
});
