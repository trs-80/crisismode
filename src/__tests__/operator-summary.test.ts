// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { buildOperatorSummary } from '../framework/operator-summary.js';
import type { HealthAssessment } from '../types/health.js';
import type { ValidationResult } from '../framework/validator.js';
import type { StepResult } from '../types/execution-state.js';

function makeHealthAssessment(
  overrides: Partial<HealthAssessment> = {},
): HealthAssessment {
  return {
    status: 'unhealthy',
    confidence: 0.97,
    summary: 'Direct health signals show the system is unhealthy.',
    observedAt: new Date().toISOString(),
    signals: [
      {
        source: 'pg_stat_replication',
        status: 'critical',
        detail: 'Worst replay lag is 45s.',
        observedAt: new Date().toISOString(),
      },
    ],
    recommendedActions: ['Run the recovery workflow in dry-run mode to determine the next safe action.'],
    ...overrides,
  };
}

function makeValidationResult(
  valid: boolean,
  checks: ValidationResult['checks'],
): ValidationResult {
  return { valid, checks };
}

describe('buildOperatorSummary', () => {
  it('reports no action required when direct health signals are healthy', () => {
    const summary = buildOperatorSummary({
      health: makeHealthAssessment({
        status: 'healthy',
        summary: 'Direct health signals show the system is healthy.',
        signals: [
          {
            source: 'pg_stat_replication',
            status: 'healthy',
            detail: 'All replicas are streaming with worst replay lag 1s.',
            observedAt: new Date().toISOString(),
          },
        ],
        recommendedActions: ['No action required. Continue monitoring the latest direct health signals.'],
      }),
      mode: 'dry-run',
      healthCheckOnly: true,
    });

    expect(summary.actionRequired).toBe('none');
    expect(summary.executeReadiness).toBe('not_applicable');
    expect(summary.mutationsPerformed).toBe(false);
  });

  it('recommends retry_with_execute after a dry-run when execute mode is ready', () => {
    const executeValidation = makeValidationResult(true, [
      {
        name: 'Provider resolution for live execution',
        passed: true,
        message: 'All providers resolved',
      },
    ]);

    const summary = buildOperatorSummary({
      health: makeHealthAssessment(),
      mode: 'dry-run',
      executeValidation,
    });

    expect(summary.actionRequired).toBe('retry_with_execute');
    expect(summary.executeReadiness).toBe('ready');
    expect(summary.recommendedNextStep).toContain('--execute');
  });

  it('reports blocked automation when execute readiness validation fails', () => {
    const blockedValidation = makeValidationResult(false, [
      {
        name: 'Provider resolution for live execution',
        passed: false,
        message: 'Missing live providers for traffic.backend.detach (step-005), db.replica.reseed (step-008), traffic.backend.attach (step-009a). Supported in this plan: db.replica.disconnect (step-004).',
        details: {
          blockedCapabilities: [
            { capability: 'traffic.backend.detach', stepId: 'step-005', resolved: false },
            { capability: 'db.replica.reseed', stepId: 'step-008', resolved: false },
            { capability: 'traffic.backend.attach', stepId: 'step-009a', resolved: false },
          ],
          supportedCapabilities: [
            { capability: 'db.replica.disconnect', stepId: 'step-004', resolved: true, providerId: 'postgresql-live-sql' },
          ],
        },
      },
    ]);

    const summary = buildOperatorSummary({
      health: makeHealthAssessment(),
      mode: 'execute',
      currentValidation: blockedValidation,
      executeValidation: blockedValidation,
    });

    expect(summary.actionRequired).toBe('use_different_tool');
    expect(summary.executeReadiness).toBe('blocked');
    expect(summary.validationBlockers[0]).toContain('Provider resolution for live execution');
    expect(summary.recommendedNextStep).toContain('Do not partially execute this plan');
    expect(summary.recommendedActions).toContain(
      'Do not partially run only the supported steps in execute mode; this recovery path requires the blocked capabilities too.',
    );
    expect(summary.recommendedActions.some((action) => action.includes('traffic.backend.detach'))).toBe(true);
    expect(summary.recommendedActions.some((action) => action.includes('db.replica.reseed'))).toBe(true);
  });

  it('reports recovery_completed after successful execute-mode mutations and healthy post-checks', () => {
    const results: StepResult[] = [
      {
        stepId: 'step-004',
        step: {
          stepId: 'step-004',
          type: 'system_action',
          name: 'Disconnect lagging replica',
          executionContext: 'postgresql_write',
          target: 'pg-primary',
          riskLevel: 'elevated',
          requiredCapabilities: ['db.replica.disconnect'],
          command: { type: 'sql', statement: 'SELECT 1;' },
          statePreservation: { before: [], after: [] },
          successCriteria: {
            description: 'Replica disconnected',
            check: { type: 'sql', expect: { operator: 'eq', value: 1 } },
          },
          blastRadius: {
            directComponents: ['pg-primary'],
            indirectComponents: [],
            maxImpact: 'low',
            cascadeRisk: 'low',
          },
          timeout: 'PT30S',
        },
        status: 'success',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 100,
      },
    ];

    const summary = buildOperatorSummary({
      health: makeHealthAssessment({
        status: 'healthy',
        summary: 'Direct health signals show the system is healthy.',
        signals: [
          {
            source: 'pg_stat_replication',
            status: 'healthy',
            detail: 'All replicas are streaming with worst replay lag 1s.',
            observedAt: new Date().toISOString(),
          },
        ],
        recommendedActions: ['No action required. Continue monitoring the latest direct health signals.'],
      }),
      mode: 'execute',
      currentValidation: makeValidationResult(true, []),
      executeValidation: makeValidationResult(true, []),
      results,
    });

    expect(summary.automationStatus).toBe('recovery_completed');
    expect(summary.mutationsPerformed).toBe(true);
    expect(summary.actionRequired).toBe('none');
  });

  it('reports partial_mutations_performed when execute mode changed state but health remains unhealthy', () => {
    const results: StepResult[] = [
      {
        stepId: 'step-004',
        step: {
          stepId: 'step-004',
          type: 'system_action',
          name: 'Disconnect lagging replica',
          executionContext: 'postgresql_write',
          target: 'pg-primary',
          riskLevel: 'elevated',
          requiredCapabilities: ['db.replica.disconnect'],
          command: { type: 'sql', statement: 'SELECT 1;' },
          statePreservation: { before: [], after: [] },
          successCriteria: {
            description: 'Replica disconnected',
            check: { type: 'sql', expect: { operator: 'eq', value: 1 } },
          },
          blastRadius: {
            directComponents: ['pg-primary'],
            indirectComponents: [],
            maxImpact: 'low',
            cascadeRisk: 'low',
          },
          timeout: 'PT30S',
        },
        status: 'success',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 100,
      },
    ];

    const summary = buildOperatorSummary({
      health: makeHealthAssessment(),
      mode: 'execute',
      currentValidation: makeValidationResult(true, []),
      executeValidation: makeValidationResult(true, []),
      results,
    });

    expect(summary.automationStatus).toBe('partial_mutations_performed');
    expect(summary.mutationsPerformed).toBe(true);
    expect(summary.actionRequired).toBe('manual_intervention_required');
    expect(summary.summary).toContain('performed some mutations');
  });
});
