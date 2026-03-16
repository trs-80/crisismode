// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import {
  RISK_ORDER,
  riskExceeds,
  getStepRisk,
  getMaxRiskIndex,
  derivePlanMaxRiskLevel,
} from '../framework/risk.js';
import type { RecoveryStep, SystemActionStep, ConditionalStep } from '../types/step-types.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { RiskLevel } from '../types/common.js';

// --- Test helpers ---

function makeSystemAction(stepId: string, riskLevel: RiskLevel): SystemActionStep {
  return {
    stepId,
    type: 'system_action',
    name: `Action ${stepId}`,
    executionContext: 'psql_cli',
    target: 'pg-primary',
    riskLevel,
    requiredCapabilities: ['db.query.read'],
    command: { type: 'sql', statement: 'SELECT 1' },
    statePreservation: { before: [], after: [] },
    successCriteria: {
      description: 'OK',
      check: { type: 'sql', statement: 'SELECT 1', expect: { operator: 'eq', value: 1 } },
    },
    blastRadius: {
      directComponents: ['pg-primary'],
      indirectComponents: [],
      maxImpact: 'test',
      cascadeRisk: 'low',
    },
    timeout: 'PT30S',
  };
}

function makeNotification(stepId: string): RecoveryStep {
  return {
    stepId,
    type: 'human_notification',
    name: `Notify ${stepId}`,
    recipients: [{ role: 'dba', urgency: 'high' }],
    message: { summary: 'test', detail: 'test', actionRequired: false },
    channel: 'auto',
  };
}

function makeConditional(
  stepId: string,
  thenStep: RecoveryStep & { type: Exclude<RecoveryStep['type'], 'conditional'> },
  elseStep: (RecoveryStep & { type: Exclude<RecoveryStep['type'], 'conditional'> }) | 'skip',
): ConditionalStep {
  return {
    stepId,
    type: 'conditional',
    name: `Conditional ${stepId}`,
    condition: {
      description: 'test condition',
      check: { type: 'sql', statement: 'SELECT 1', expect: { operator: 'eq', value: 1 } },
    },
    thenStep,
    elseStep,
  };
}

function makePlan(steps: RecoveryStep[]): RecoveryPlan {
  return {
    apiVersion: 'v0.2.1',
    kind: 'RecoveryPlan',
    metadata: {
      planId: 'test-plan',
      agentName: 'test-agent',
      agentVersion: '1.0.0',
      scenario: 'test_scenario',
      createdAt: new Date().toISOString(),
      estimatedDuration: 'PT1M',
      summary: 'Test plan',
      supersedes: null,
    },
    impact: {
      affectedSystems: [],
      affectedServices: [],
      estimatedUserImpact: 'none',
      dataLossRisk: 'none',
    },
    steps,
    rollbackStrategy: { type: 'none', description: 'Test' },
  };
}

// --- Tests ---

describe('RISK_ORDER', () => {
  it('orders risk levels from lowest to highest', () => {
    expect(RISK_ORDER).toEqual(['routine', 'elevated', 'high', 'critical']);
  });
});

describe('riskExceeds', () => {
  it('returns true when first level is strictly higher', () => {
    expect(riskExceeds('elevated', 'routine')).toBe(true);
    expect(riskExceeds('high', 'elevated')).toBe(true);
    expect(riskExceeds('critical', 'high')).toBe(true);
    expect(riskExceeds('critical', 'routine')).toBe(true);
  });

  it('returns false when levels are equal', () => {
    for (const level of RISK_ORDER) {
      expect(riskExceeds(level, level)).toBe(false);
    }
  });

  it('returns false when first level is lower', () => {
    expect(riskExceeds('routine', 'elevated')).toBe(false);
    expect(riskExceeds('elevated', 'high')).toBe(false);
    expect(riskExceeds('high', 'critical')).toBe(false);
  });
});

describe('getStepRisk', () => {
  it('returns risk level for system_action steps', () => {
    expect(getStepRisk(makeSystemAction('s1', 'elevated'))).toBe('elevated');
    expect(getStepRisk(makeSystemAction('s2', 'critical'))).toBe('critical');
  });

  it('returns null for non-risk-bearing step types', () => {
    expect(getStepRisk(makeNotification('n1'))).toBeNull();
    expect(getStepRisk({
      stepId: 'c1',
      type: 'checkpoint',
      name: 'Checkpoint',
      stateCaptures: [],
    })).toBeNull();
  });

  it('returns the higher risk from conditional branches', () => {
    const cond = makeConditional(
      'cond-1',
      makeSystemAction('then', 'elevated'),
      makeSystemAction('else', 'high'),
    );
    expect(getStepRisk(cond)).toBe('high');
  });

  it('returns then-branch risk when else is skip', () => {
    const cond = makeConditional(
      'cond-2',
      makeSystemAction('then', 'elevated'),
      'skip',
    );
    expect(getStepRisk(cond)).toBe('elevated');
  });

  it('returns else-branch risk when then-branch has no risk', () => {
    const cond = makeConditional(
      'cond-3',
      makeNotification('then') as any,
      makeSystemAction('else', 'high'),
    );
    expect(getStepRisk(cond)).toBe('high');
  });

  it('returns null when both conditional branches have no risk', () => {
    const cond = makeConditional(
      'cond-4',
      makeNotification('then') as any,
      makeNotification('else') as any,
    );
    expect(getStepRisk(cond)).toBeNull();
  });

  it('returns null when conditional has notification then-branch and skip else', () => {
    const cond = makeConditional(
      'cond-5',
      makeNotification('then') as any,
      'skip',
    );
    expect(getStepRisk(cond)).toBeNull();
  });

  it('returns the then-branch risk when both branches have equal risk', () => {
    const cond = makeConditional(
      'cond-6',
      makeSystemAction('then', 'elevated'),
      makeSystemAction('else', 'elevated'),
    );
    // When equal, thenRisk is returned (indexOf >= indexOf)
    expect(getStepRisk(cond)).toBe('elevated');
  });
});

describe('getMaxRiskIndex', () => {
  it('returns 0 for empty step list', () => {
    expect(getMaxRiskIndex([])).toBe(0);
  });

  it('returns 0 for steps with no system actions', () => {
    expect(getMaxRiskIndex([makeNotification('n1')])).toBe(0);
  });

  it('returns the index of the highest risk system action', () => {
    const steps: RecoveryStep[] = [
      makeSystemAction('s1', 'routine'),
      makeSystemAction('s2', 'high'),
      makeSystemAction('s3', 'elevated'),
    ];
    expect(getMaxRiskIndex(steps)).toBe(RISK_ORDER.indexOf('high'));
  });

  it('considers system actions inside conditional branches', () => {
    const steps: RecoveryStep[] = [
      makeSystemAction('s1', 'routine'),
      makeConditional('c1', makeSystemAction('then', 'critical'), 'skip'),
    ];
    expect(getMaxRiskIndex(steps)).toBe(RISK_ORDER.indexOf('critical'));
  });

  it('considers both then and else branches of conditionals', () => {
    const steps: RecoveryStep[] = [
      makeConditional(
        'c1',
        makeSystemAction('then', 'elevated'),
        makeSystemAction('else', 'high'),
      ),
    ];
    expect(getMaxRiskIndex(steps)).toBe(RISK_ORDER.indexOf('high'));
  });

  it('ignores conditional else when it is skip', () => {
    const steps: RecoveryStep[] = [
      makeConditional('c1', makeSystemAction('then', 'elevated'), 'skip'),
    ];
    expect(getMaxRiskIndex(steps)).toBe(RISK_ORDER.indexOf('elevated'));
  });
});

describe('derivePlanMaxRiskLevel', () => {
  it('returns routine for a plan with no system actions', () => {
    const plan = makePlan([makeNotification('n1')]);
    expect(derivePlanMaxRiskLevel(plan)).toBe('routine');
  });

  it('returns the highest risk level across all steps', () => {
    const plan = makePlan([
      makeSystemAction('s1', 'routine'),
      makeSystemAction('s2', 'elevated'),
      makeNotification('n1'),
    ]);
    expect(derivePlanMaxRiskLevel(plan)).toBe('elevated');
  });

  it('considers conditional branch steps', () => {
    const plan = makePlan([
      makeSystemAction('s1', 'routine'),
      makeConditional('c1', makeSystemAction('then', 'critical'), 'skip'),
    ]);
    expect(derivePlanMaxRiskLevel(plan)).toBe('critical');
  });

  it('returns routine for an empty plan', () => {
    const plan = makePlan([]);
    expect(derivePlanMaxRiskLevel(plan)).toBe('routine');
  });
});
