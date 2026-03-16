// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import {
  walkSteps,
  collectSystemActions,
  collectExecutionContexts,
} from '../framework/step-walker.js';
import type { RecoveryStep, SystemActionStep, ConditionalStep } from '../types/step-types.js';
import type { RiskLevel } from '../types/common.js';

// --- Test helpers ---

function makeSystemAction(stepId: string, opts?: { context?: string; riskLevel?: RiskLevel }): SystemActionStep {
  return {
    stepId,
    type: 'system_action',
    name: `Action ${stepId}`,
    executionContext: opts?.context ?? 'psql_cli',
    target: 'pg-primary',
    riskLevel: opts?.riskLevel ?? 'routine',
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

function makeDiagnosis(stepId: string, context?: string): RecoveryStep {
  return {
    stepId,
    type: 'diagnosis_action',
    name: `Diagnosis ${stepId}`,
    executionContext: context ?? 'psql_cli',
    target: 'pg-primary',
    command: { type: 'sql', statement: 'SELECT 1' },
    timeout: 'PT10S',
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

// --- Tests ---

describe('walkSteps', () => {
  it('visits each top-level step', () => {
    const visited: string[] = [];
    const steps: RecoveryStep[] = [
      makeNotification('n1'),
      makeSystemAction('s1'),
      makeNotification('n2'),
    ];
    walkSteps(steps, (step) => visited.push(step.stepId));
    expect(visited).toEqual(['n1', 's1', 'n2']);
  });

  it('visits conditional then and else branches', () => {
    const visited: string[] = [];
    const steps: RecoveryStep[] = [
      makeConditional('c1', makeSystemAction('then'), makeNotification('else') as any),
    ];
    walkSteps(steps, (step) => visited.push(step.stepId));
    expect(visited).toEqual(['c1', 'then', 'else']);
  });

  it('visits conditional then branch but not else when else is skip', () => {
    const visited: string[] = [];
    const steps: RecoveryStep[] = [
      makeConditional('c1', makeSystemAction('then'), 'skip'),
    ];
    walkSteps(steps, (step) => visited.push(step.stepId));
    expect(visited).toEqual(['c1', 'then']);
  });

  it('handles empty step list', () => {
    const visitor = vi.fn();
    walkSteps([], visitor);
    expect(visitor).not.toHaveBeenCalled();
  });

  it('visits multiple conditionals and flat steps interleaved', () => {
    const visited: string[] = [];
    const steps: RecoveryStep[] = [
      makeNotification('n1'),
      makeConditional('c1', makeSystemAction('t1'), makeSystemAction('e1')),
      makeSystemAction('s1'),
      makeConditional('c2', makeNotification('t2') as any, 'skip'),
    ];
    walkSteps(steps, (step) => visited.push(step.stepId));
    expect(visited).toEqual(['n1', 'c1', 't1', 'e1', 's1', 'c2', 't2']);
  });
});

describe('collectSystemActions', () => {
  it('returns empty array for steps with no system actions', () => {
    const steps: RecoveryStep[] = [makeNotification('n1'), makeNotification('n2')];
    expect(collectSystemActions(steps)).toEqual([]);
  });

  it('collects top-level system actions', () => {
    const s1 = makeSystemAction('s1');
    const s2 = makeSystemAction('s2');
    const steps: RecoveryStep[] = [makeNotification('n1'), s1, s2];
    const result = collectSystemActions(steps);
    expect(result).toHaveLength(2);
    expect(result[0].stepId).toBe('s1');
    expect(result[1].stepId).toBe('s2');
  });

  it('collects system actions from conditional branches', () => {
    const thenAction = makeSystemAction('then-action');
    const elseAction = makeSystemAction('else-action');
    const steps: RecoveryStep[] = [
      makeConditional('c1', thenAction, elseAction),
    ];
    const result = collectSystemActions(steps);
    expect(result).toHaveLength(2);
    expect(result[0].stepId).toBe('then-action');
    expect(result[1].stepId).toBe('else-action');
  });

  it('does not include the conditional step itself', () => {
    const steps: RecoveryStep[] = [
      makeConditional('c1', makeSystemAction('then'), 'skip'),
    ];
    const result = collectSystemActions(steps);
    expect(result).toHaveLength(1);
    expect(result[0].stepId).toBe('then');
  });

  it('skips else branch when it is skip', () => {
    const steps: RecoveryStep[] = [
      makeConditional('c1', makeSystemAction('then'), 'skip'),
    ];
    expect(collectSystemActions(steps)).toHaveLength(1);
  });

  it('returns empty array for empty steps', () => {
    expect(collectSystemActions([])).toEqual([]);
  });
});

describe('collectExecutionContexts', () => {
  it('collects contexts from system_action steps', () => {
    const steps: RecoveryStep[] = [
      makeSystemAction('s1', { context: 'psql_cli' }),
      makeSystemAction('s2', { context: 'linux_process' }),
    ];
    const contexts = collectExecutionContexts(steps);
    expect(contexts).toEqual(new Set(['psql_cli', 'linux_process']));
  });

  it('collects contexts from diagnosis_action steps', () => {
    const steps: RecoveryStep[] = [
      makeDiagnosis('d1', 'psql_cli'),
      makeDiagnosis('d2', 'redis_cli'),
    ];
    const contexts = collectExecutionContexts(steps);
    expect(contexts).toEqual(new Set(['psql_cli', 'redis_cli']));
  });

  it('ignores step types that do not have execution contexts', () => {
    const steps: RecoveryStep[] = [
      makeNotification('n1'),
      makeSystemAction('s1', { context: 'psql_cli' }),
    ];
    const contexts = collectExecutionContexts(steps);
    expect(contexts).toEqual(new Set(['psql_cli']));
  });

  it('deduplicates identical contexts', () => {
    const steps: RecoveryStep[] = [
      makeSystemAction('s1', { context: 'psql_cli' }),
      makeSystemAction('s2', { context: 'psql_cli' }),
      makeDiagnosis('d1', 'psql_cli'),
    ];
    const contexts = collectExecutionContexts(steps);
    expect(contexts.size).toBe(1);
    expect(contexts.has('psql_cli')).toBe(true);
  });

  it('collects contexts from conditional branches', () => {
    const steps: RecoveryStep[] = [
      makeConditional(
        'c1',
        makeSystemAction('then', { context: 'psql_cli' }),
        makeSystemAction('else', { context: 'linux_process' }),
      ),
    ];
    const contexts = collectExecutionContexts(steps);
    expect(contexts).toEqual(new Set(['psql_cli', 'linux_process']));
  });

  it('collects context from conditional then-branch when else is skip', () => {
    const steps: RecoveryStep[] = [
      makeConditional(
        'c1',
        makeSystemAction('then', { context: 'redis_cli' }),
        'skip',
      ),
    ];
    const contexts = collectExecutionContexts(steps);
    expect(contexts).toEqual(new Set(['redis_cli']));
  });

  it('returns empty set for empty steps', () => {
    expect(collectExecutionContexts([])).toEqual(new Set());
  });

  it('returns empty set for steps with no execution contexts', () => {
    const steps: RecoveryStep[] = [makeNotification('n1')];
    expect(collectExecutionContexts(steps)).toEqual(new Set());
  });
});
