// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { validatePlan } from '../framework/validator.js';
import { pgReplicationManifest } from '../agent/pg-replication/manifest.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { RecoveryStep } from '../types/step-types.js';

function makePlan(overrides: Partial<RecoveryPlan> = {}, steps?: RecoveryStep[]): RecoveryPlan {
  return {
    apiVersion: 'v0.2.1',
    kind: 'RecoveryPlan',
    metadata: {
      planId: 'test-plan',
      agentName: 'postgresql-replication-recovery',
      agentVersion: '1.2.0',
      scenario: 'replication_lag_cascade',
      createdAt: new Date().toISOString(),
      estimatedDuration: 'PT10M',
      summary: 'Test plan',
      supersedes: null,
    },
    impact: {
      affectedSystems: [],
      affectedServices: [],
      estimatedUserImpact: 'none',
      dataLossRisk: 'none',
    },
    steps: steps ?? [
      {
        stepId: 'step-001',
        type: 'human_notification',
        name: 'Notify',
        recipients: [{ role: 'on_call_dba', urgency: 'high' }],
        message: { summary: 'Test', detail: 'Test', actionRequired: false },
        channel: 'auto',
      },
    ],
    rollbackStrategy: {
      type: 'stepwise',
      description: 'Rollback in reverse order.',
    },
    ...overrides,
  };
}

const manifest = pgReplicationManifest;

describe('validatePlan', () => {
  it('passes a valid plan', () => {
    const result = validatePlan(makePlan(), manifest);
    expect(result.valid).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('fails when scenario is not in manifest', () => {
    const plan = makePlan({
      metadata: {
        ...makePlan().metadata,
        scenario: 'unknown_scenario',
      },
    });
    const result = validatePlan(plan, manifest);
    expect(result.valid).toBe(false);
    expect(result.checks.find((c) => c.name === 'Scenario declared in manifest')?.passed).toBe(false);
  });

  it('fails when execution context is undeclared', () => {
    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Test',
        executionContext: 'kubernetes_admin',
        target: 'k8s-cluster',
        command: { type: 'kubernetes_api', statement: 'kubectl get pods' },
        timeout: 'PT30S',
      },
    ];
    const result = validatePlan(makePlan({}, steps), manifest);
    expect(result.checks.find((c) => c.name === 'Execution contexts declared')?.passed).toBe(false);
  });

  it('fails when risk level exceeds manifest max', () => {
    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'human_notification',
        name: 'Notify',
        recipients: [{ role: 'on_call_dba', urgency: 'high' }],
        message: { summary: 'Test', detail: 'Test', actionRequired: false },
        channel: 'auto',
      },
      {
        stepId: 'step-002',
        type: 'system_action',
        name: 'Critical action',
        executionContext: 'postgresql_write',
        target: 'pg-primary',
        riskLevel: 'critical',
        command: { type: 'sql', statement: 'DROP DATABASE production;' },
        statePreservation: {
          before: [{
            name: 'pre',
            captureType: 'sql_query',
            statement: 'SELECT 1;',
            captureCost: 'negligible',
            capturePolicy: 'required',
            retention: 'P30D',
          }],
          after: [],
        },
        successCriteria: { description: 'Done', check: { type: 'sql', expect: { operator: 'eq', value: 1 } } },
        blastRadius: { directComponents: ['pg-primary'], indirectComponents: [], maxImpact: 'total', cascadeRisk: 'high' },
        timeout: 'PT30S',
      },
    ];
    const result = validatePlan(makePlan({}, steps), manifest);
    expect(result.checks.find((c) => c.name === 'Risk levels within manifest maximum')?.passed).toBe(false);
  });

  it('fails when step IDs are duplicated', () => {
    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'human_notification',
        name: 'Notify 1',
        recipients: [{ role: 'on_call_dba', urgency: 'high' }],
        message: { summary: 'Test', detail: 'Test', actionRequired: false },
        channel: 'auto',
      },
      {
        stepId: 'step-001',
        type: 'human_notification',
        name: 'Notify 2',
        recipients: [{ role: 'on_call_dba', urgency: 'high' }],
        message: { summary: 'Test', detail: 'Test', actionRequired: false },
        channel: 'auto',
      },
    ];
    const result = validatePlan(makePlan({}, steps), manifest);
    expect(result.checks.find((c) => c.name === 'Unique step IDs')?.passed).toBe(false);
  });

  it('fails when elevated step has no state preservation', () => {
    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'human_notification',
        name: 'Notify',
        recipients: [{ role: 'on_call_dba', urgency: 'high' }],
        message: { summary: 'Test', detail: 'Test', actionRequired: false },
        channel: 'auto',
      },
      {
        stepId: 'step-002',
        type: 'system_action',
        name: 'Elevated action',
        executionContext: 'postgresql_write',
        target: 'pg-primary',
        riskLevel: 'elevated',
        command: { type: 'sql', statement: 'SELECT 1;' },
        statePreservation: { before: [], after: [] },
        successCriteria: { description: 'Done', check: { type: 'sql', expect: { operator: 'eq', value: 1 } } },
        blastRadius: { directComponents: ['pg-primary'], indirectComponents: [], maxImpact: 'low', cascadeRisk: 'low' },
        timeout: 'PT30S',
      },
    ];
    const result = validatePlan(makePlan({}, steps), manifest);
    expect(result.checks.find((c) => c.name === 'State preservation for elevated+ steps')?.passed).toBe(false);
  });

  it('fails when elevated plan has no human notification', () => {
    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'system_action',
        name: 'Elevated action',
        executionContext: 'postgresql_write',
        target: 'pg-primary',
        riskLevel: 'elevated',
        command: { type: 'sql', statement: 'SELECT 1;' },
        statePreservation: {
          before: [{
            name: 'pre',
            captureType: 'sql_query',
            statement: 'SELECT 1;',
            captureCost: 'negligible',
            capturePolicy: 'required',
            retention: 'P30D',
          }],
          after: [],
        },
        successCriteria: { description: 'Done', check: { type: 'sql', expect: { operator: 'eq', value: 1 } } },
        blastRadius: { directComponents: ['pg-primary'], indirectComponents: [], maxImpact: 'low', cascadeRisk: 'low' },
        timeout: 'PT30S',
      },
    ];
    const result = validatePlan(makePlan({}, steps), manifest);
    expect(result.checks.find((c) => c.name === 'Human notification for elevated+ plans')?.passed).toBe(false);
  });

  it('fails when rollback strategy is missing', () => {
    const plan = makePlan();
    (plan as unknown as Record<string, unknown>).rollbackStrategy = undefined;
    const result = validatePlan(plan, manifest);
    expect(result.checks.find((c) => c.name === 'Rollback strategy declared')?.passed).toBe(false);
  });
});
