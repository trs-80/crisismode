// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import {
  stepEscalationLevel,
  planEscalationLevel,
  riskToEscalation,
  getEscalationInfo,
  allEscalationLevels,
} from '../framework/escalation.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { RecoveryStep, DiagnosisActionStep, SystemActionStep, ConditionalStep } from '../types/step-types.js';

// ── Risk → Escalation mapping ──

describe('riskToEscalation', () => {
  it('maps routine risk to level 4 (Repair safe)', () => {
    expect(riskToEscalation('routine')).toBe(4);
  });

  it('maps elevated risk to level 4 (Repair safe)', () => {
    expect(riskToEscalation('elevated')).toBe(4);
  });

  it('maps high risk to level 5 (Repair destructive)', () => {
    expect(riskToEscalation('high')).toBe(5);
  });

  it('maps critical risk to level 5 (Repair destructive)', () => {
    expect(riskToEscalation('critical')).toBe(5);
  });
});

// ── Step escalation levels ──

describe('stepEscalationLevel', () => {
  it('returns level 2 for diagnosis_action', () => {
    const step: DiagnosisActionStep = {
      stepId: 'diag-1',
      type: 'diagnosis_action',
      name: 'Check status',
      executionContext: 'pg_read',
      target: 'postgresql',
      command: { type: 'sql', statement: 'SELECT 1' },
      timeout: '30s',
    };
    expect(stepEscalationLevel(step)).toBe(2);
  });

  it('returns level 3 for human_notification', () => {
    const step: RecoveryStep = {
      stepId: 'notify-1',
      type: 'human_notification',
      name: 'Notify team',
      recipients: [{ role: 'dba', urgency: 'high' }],
      message: { summary: 'Alert', detail: 'Details', actionRequired: true },
      channel: 'slack',
    };
    expect(stepEscalationLevel(step)).toBe(3);
  });

  it('returns level 4 for routine system_action', () => {
    const step: SystemActionStep = {
      stepId: 'action-1',
      type: 'system_action',
      name: 'Routine action',
      executionContext: 'pg_write',
      target: 'postgresql',
      riskLevel: 'routine',
      requiredCapabilities: ['db.query.read'],
      command: { type: 'sql', statement: 'SELECT 1' },
      statePreservation: { before: [], after: [] },
      successCriteria: { description: 'OK', check: { type: 'sql', expect: { operator: 'eq', value: true } } },
      blastRadius: { directComponents: ['replica-1'], indirectComponents: [], maxImpact: 'none', cascadeRisk: 'none' },
      timeout: '30s',
    };
    expect(stepEscalationLevel(step)).toBe(4);
  });

  it('returns level 5 for high risk system_action', () => {
    const step: SystemActionStep = {
      stepId: 'action-2',
      type: 'system_action',
      name: 'High risk action',
      executionContext: 'pg_write',
      target: 'postgresql',
      riskLevel: 'high',
      requiredCapabilities: ['db.replica.disconnect'],
      command: { type: 'sql', statement: 'SELECT pg_terminate_backend(...)' },
      statePreservation: { before: [], after: [] },
      successCriteria: { description: 'OK', check: { type: 'sql', expect: { operator: 'eq', value: true } } },
      blastRadius: { directComponents: ['replica-1'], indirectComponents: [], maxImpact: 'service disruption', cascadeRisk: 'medium' },
      timeout: '30s',
    };
    expect(stepEscalationLevel(step)).toBe(5);
  });

  it('returns max of then/else for conditional steps', () => {
    const step: ConditionalStep = {
      stepId: 'cond-1',
      type: 'conditional',
      name: 'Conditional',
      condition: { description: 'check', check: { type: 'sql', expect: { operator: 'eq', value: true } } },
      thenStep: {
        stepId: 'then-1',
        type: 'system_action',
        name: 'High risk',
        executionContext: 'pg_write',
        target: 'postgresql',
        riskLevel: 'critical',
        requiredCapabilities: [],
        command: { type: 'sql' },
        statePreservation: { before: [], after: [] },
        successCriteria: { description: 'OK', check: { type: 'sql', expect: { operator: 'eq', value: true } } },
        blastRadius: { directComponents: [], indirectComponents: [], maxImpact: 'high', cascadeRisk: 'high' },
        timeout: '30s',
      },
      elseStep: {
        stepId: 'else-1',
        type: 'diagnosis_action',
        name: 'Diagnose',
        executionContext: 'pg_read',
        target: 'postgresql',
        command: { type: 'sql', statement: 'SELECT 1' },
        timeout: '30s',
      },
    };
    expect(stepEscalationLevel(step)).toBe(5); // max of critical (5) and diagnosis (2)
  });

  it('handles conditional with skip else', () => {
    const step: ConditionalStep = {
      stepId: 'cond-2',
      type: 'conditional',
      name: 'Conditional skip',
      condition: { description: 'check', check: { type: 'sql', expect: { operator: 'eq', value: true } } },
      thenStep: {
        stepId: 'then-2',
        type: 'diagnosis_action',
        name: 'Diagnose',
        executionContext: 'pg_read',
        target: 'postgresql',
        command: { type: 'sql' },
        timeout: '30s',
      },
      elseStep: 'skip',
    };
    expect(stepEscalationLevel(step)).toBe(2);
  });
});

// ── Plan escalation levels ──

describe('planEscalationLevel', () => {
  const basePlan: RecoveryPlan = {
    apiVersion: 'v0.2.1',
    kind: 'RecoveryPlan',
    metadata: {
      planId: 'test',
      agentName: 'test-agent',
      agentVersion: '1.0.0',
      scenario: 'test',
      createdAt: new Date().toISOString(),
      estimatedDuration: '1m',
      summary: 'Test',
      supersedes: null,
    },
    impact: {
      affectedSystems: [],
      affectedServices: [],
      estimatedUserImpact: 'none',
      dataLossRisk: 'none',
    },
    steps: [],
    rollbackStrategy: { type: 'none', description: 'N/A' },
  };

  it('returns level 3 for empty plan', () => {
    expect(planEscalationLevel(basePlan)).toBe(3);
  });

  it('returns level 3 for plan with only notifications', () => {
    const plan: RecoveryPlan = {
      ...basePlan,
      steps: [{
        stepId: 'n-1',
        type: 'human_notification',
        name: 'Notify',
        recipients: [{ role: 'ops', urgency: 'low' }],
        message: { summary: 'Info', detail: 'Details', actionRequired: false },
        channel: 'email',
      }],
    };
    expect(planEscalationLevel(plan)).toBe(3);
  });

  it('returns level 5 for plan with critical system action', () => {
    const plan: RecoveryPlan = {
      ...basePlan,
      steps: [{
        stepId: 'a-1',
        type: 'system_action',
        name: 'Critical action',
        executionContext: 'pg_admin',
        target: 'postgresql',
        riskLevel: 'critical',
        requiredCapabilities: [],
        command: { type: 'sql' },
        statePreservation: { before: [], after: [] },
        successCriteria: { description: 'OK', check: { type: 'sql', expect: { operator: 'eq', value: true } } },
        blastRadius: { directComponents: [], indirectComponents: [], maxImpact: 'high', cascadeRisk: 'high' },
        timeout: '60s',
      }],
    };
    expect(planEscalationLevel(plan)).toBe(5);
  });
});

// ── Escalation info ──

describe('getEscalationInfo', () => {
  it('returns correct info for level 1', () => {
    const info = getEscalationInfo(1);
    expect(info.label).toBe('Observe');
    expect(info.level).toBe(1);
    expect(info.description).toContain('Read-only');
  });

  it('returns correct info for level 5', () => {
    const info = getEscalationInfo(5);
    expect(info.label).toBe('Repair (destructive)');
    expect(info.gate).toContain('human approval');
  });
});

describe('allEscalationLevels', () => {
  it('returns all 5 levels', () => {
    const levels = allEscalationLevels();
    expect(levels).toHaveLength(5);
    expect(levels.map((l) => l.level)).toEqual([1, 2, 3, 4, 5]);
  });
});
