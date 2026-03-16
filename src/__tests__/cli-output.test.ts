// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configure, printHealthStatus, printDiagnosis, printStatus, printError } from '../cli/output.js';
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
});
