// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { generateDiagnosisReport } from '../framework/incident-report.js';
import type { DiagnosisResult } from '../types/diagnosis-result.js';
import type { HealthAssessment, OperatorSummary } from '../types/health.js';

describe('generateDiagnosisReport', () => {
  it('produces a markdown report with all required sections', () => {
    const diagnosis: DiagnosisResult = {
      status: 'identified',
      scenario: 'replication_lag_cascade',
      confidence: 0.85,
      findings: [
        { source: 'pg_stat_replication', observation: 'Replica lag exceeds 30s', severity: 'critical' },
        { source: 'connection_pool', observation: 'Pool utilization at 92%', severity: 'warning' },
      ],
      diagnosticPlanNeeded: false,
    };

    const health: HealthAssessment = {
      status: 'unhealthy',
      confidence: 0.9,
      summary: 'PostgreSQL replication is degraded',
      observedAt: new Date().toISOString(),
      signals: [
        { source: 'replication', status: 'critical', detail: 'Lag > 30s', observedAt: new Date().toISOString() },
      ],
      recommendedActions: ['Investigate replication lag', 'Consider disconnecting lagging replica'],
    };

    const operatorSummary: OperatorSummary = {
      currentState: 'unhealthy',
      confidence: 0.9,
      summary: 'System is unhealthy',
      actionRequired: 'retry_with_execute',
      automationStatus: 'no_mutations_performed',
      executeReadiness: 'ready',
      mutationsPerformed: false,
      recommendedNextStep: 'Run with --execute',
      recommendedActions: ['Investigate replication lag'],
      evidence: health.signals,
      validationBlockers: [],
      observedAt: new Date().toISOString(),
    };

    const report = generateDiagnosisReport(diagnosis, health, operatorSummary);

    expect(report.markdown).toContain('# Health & Diagnosis Report');
    expect(report.markdown).toContain('Health Assessment');
    expect(report.markdown).toContain('Diagnosis');
    expect(report.markdown).toContain('unhealthy');
    expect(report.markdown).toContain('Replication Lag Cascade');
    expect(report.sections.length).toBeGreaterThan(0);
  });
});
