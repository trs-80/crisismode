// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { validatePlan } from '../framework/validator.js';
import { pgReplicationManifest } from '../agent/pg-replication/manifest.js';
import { PgSimulator } from '../agent/pg-replication/simulator.js';
import { PgLiveClient } from '../agent/pg-replication/live-client.js';
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
        requiredCapabilities: ['db.query.write'],
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
        requiredCapabilities: ['db.query.write'],
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
        requiredCapabilities: ['db.query.write'],
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

  it('fails when a plan contains nested conditionals from an external source', () => {
    const nestedConditional = {
      stepId: 'step-001',
      type: 'conditional',
      name: 'Outer conditional',
      condition: {
        description: 'outer condition',
        check: { type: 'sql', expect: { operator: 'eq', value: 1 } },
      },
      thenStep: {
        stepId: 'step-001a',
        type: 'conditional',
        name: 'Inner conditional',
        condition: {
          description: 'inner condition',
          check: { type: 'sql', expect: { operator: 'eq', value: 1 } },
        },
        thenStep: {
          stepId: 'step-001a-i',
          type: 'human_notification',
          name: 'Inner notify',
          recipients: [{ role: 'on_call_dba', urgency: 'high' }],
          message: { summary: 'Test', detail: 'Test', actionRequired: false },
          channel: 'auto',
        },
        elseStep: 'skip',
      },
      elseStep: 'skip',
    } as unknown as RecoveryStep;

    const result = validatePlan(makePlan({}, [nestedConditional]), manifest);
    expect(result.checks.find((c) => c.name === 'No nested conditionals')?.passed).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('fails when a system action omits required capabilities', () => {
    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'system_action',
        name: 'Capability-less action',
        executionContext: 'postgresql_write',
        target: 'pg-primary',
        riskLevel: 'routine',
        requiredCapabilities: [],
        command: { type: 'sql', statement: 'SELECT 1;' },
        statePreservation: { before: [], after: [] },
        successCriteria: { description: 'Done', check: { type: 'sql', expect: { operator: 'eq', value: 1 } } },
        blastRadius: { directComponents: ['pg-primary'], indirectComponents: [], maxImpact: 'low', cascadeRisk: 'low' },
        timeout: 'PT30S',
      },
    ];

    const result = validatePlan(makePlan({}, steps), manifest);
    expect(result.checks.find((c) => c.name === 'System actions declare required capabilities')?.passed).toBe(false);
  });

  it('fails when a system action references an unknown capability', () => {
    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'system_action',
        name: 'Unknown capability action',
        executionContext: 'postgresql_write',
        target: 'pg-primary',
        riskLevel: 'routine',
        requiredCapabilities: ['db.unknown.capability'],
        command: { type: 'sql', statement: 'SELECT 1;' },
        statePreservation: { before: [], after: [] },
        successCriteria: { description: 'Done', check: { type: 'sql', expect: { operator: 'eq', value: 1 } } },
        blastRadius: { directComponents: ['pg-primary'], indirectComponents: [], maxImpact: 'low', cascadeRisk: 'low' },
        timeout: 'PT30S',
      },
    ];

    const result = validatePlan(makePlan({}, steps), manifest);
    expect(result.checks.find((c) => c.name === 'Step capabilities are registered')?.passed).toBe(false);
  });

  it('fails live validation when required capabilities are unresolved for the execution context', () => {
    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'system_action',
        name: 'Mismatched capability action',
        executionContext: 'linux_process',
        target: 'load-balancer',
        riskLevel: 'routine',
        requiredCapabilities: ['db.replica.disconnect'],
        command: {
          type: 'structured_command',
          operation: 'config_reload',
          parameters: { service: 'load-balancer' },
        },
        statePreservation: { before: [], after: [] },
        successCriteria: {
          description: 'Done',
          check: { type: 'structured_command', expect: { operator: 'eq', value: 'running' } },
        },
        blastRadius: { directComponents: ['load-balancer'], indirectComponents: [], maxImpact: 'low', cascadeRisk: 'low' },
        timeout: 'PT30S',
      },
    ];

    const structural = validatePlan(makePlan({}, steps), manifest);
    expect(structural.valid).toBe(true);

    const executable = validatePlan(makePlan({}, steps), manifest, {
      requireExecutableCapabilities: true,
    });
    expect(executable.checks.find((c) => c.name === 'Required capabilities resolve for live execution')?.passed).toBe(false);
    expect(executable.valid).toBe(false);
  });

  it('passes provider resolution when a backend supports the requested capability in execute mode', () => {
    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'system_action',
        name: 'Disconnect replica',
        executionContext: 'postgresql_write',
        target: 'pg-primary',
        riskLevel: 'routine',
        requiredCapabilities: ['db.replica.disconnect'],
        command: {
          type: 'sql',
          statement: "SELECT pg_terminate_backend(pid) FROM pg_stat_replication WHERE client_addr = '10.0.1.52';",
        },
        statePreservation: { before: [], after: [] },
        successCriteria: {
          description: 'Done',
          check: { type: 'sql', expect: { operator: 'eq', value: 1 } },
        },
        blastRadius: { directComponents: ['pg-primary'], indirectComponents: [], maxImpact: 'low', cascadeRisk: 'low' },
        timeout: 'PT30S',
      },
    ];

    const result = validatePlan(makePlan({}, steps), manifest, {
      requireExecutableCapabilities: true,
      backend: new PgSimulator(),
      executionMode: 'execute',
    });

    expect(result.valid).toBe(true);
    const providerCheck = result.checks.find((c) => c.name === 'Provider resolution for live execution');
    expect(providerCheck?.passed).toBe(true);
    expect(providerCheck?.message).toContain('All 1 live capability requirement(s) resolved successfully.');
  });

  it('fails provider resolution when no live provider supports the requested capability', async () => {
    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'system_action',
        name: 'Detach load balancer backend',
        executionContext: 'linux_process',
        target: 'load-balancer',
        riskLevel: 'routine',
        requiredCapabilities: ['traffic.backend.detach'],
        command: {
          type: 'structured_command',
          operation: 'config_reload',
          parameters: { service: 'load-balancer' },
        },
        statePreservation: { before: [], after: [] },
        successCriteria: {
          description: 'Done',
          check: { type: 'structured_command', expect: { operator: 'eq', value: 'running' } },
        },
        blastRadius: { directComponents: ['load-balancer'], indirectComponents: [], maxImpact: 'low', cascadeRisk: 'low' },
        timeout: 'PT30S',
      },
    ];

    const backend = new PgLiveClient(
      {
        host: '127.0.0.1',
        port: 5432,
        user: 'postgres',
        password: 'postgres',
        database: 'crisismode',
      },
    );

    try {
      const result = validatePlan(makePlan({}, steps), manifest, {
        requireExecutableCapabilities: true,
        backend,
        executionMode: 'execute',
      });

      expect(result.valid).toBe(false);
      const providerCheck = result.checks.find((c) => c.name === 'Provider resolution for live execution');
      expect(providerCheck?.passed).toBe(false);
      expect(providerCheck?.message).toContain('Missing live providers for traffic.backend.detach (step-001).');
    } finally {
      await backend.close();
    }
  });

  it('does not run provider-resolution validation in dry-run mode', () => {
    const steps: RecoveryStep[] = [
      {
        stepId: 'step-001',
        type: 'system_action',
        name: 'Detach load balancer backend',
        executionContext: 'linux_process',
        target: 'load-balancer',
        riskLevel: 'routine',
        requiredCapabilities: ['traffic.backend.detach'],
        command: {
          type: 'structured_command',
          operation: 'config_reload',
          parameters: { service: 'load-balancer' },
        },
        statePreservation: { before: [], after: [] },
        successCriteria: {
          description: 'Done',
          check: { type: 'structured_command', expect: { operator: 'eq', value: 'running' } },
        },
        blastRadius: { directComponents: ['load-balancer'], indirectComponents: [], maxImpact: 'low', cascadeRisk: 'low' },
        timeout: 'PT30S',
      },
    ];

    const result = validatePlan(makePlan({}, steps), manifest, {
      backend: new PgSimulator(),
      executionMode: 'dry-run',
    });

    expect(result.valid).toBe(true);
    expect(result.checks.find((c) => c.name === 'Provider resolution for live execution')).toBeUndefined();
  });
});
