// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { buildRiskFraming } from '../cli/risk-framing.js';

function systemStep(overrides: Record<string, unknown> = {}) {
  return {
    stepId: 's1',
    type: 'system_action' as const,
    name: 'Disconnect replica',
    description: 'Disconnect the lagging replica from the primary',
    executionContext: 'primary',
    target: 'pg-primary',
    riskLevel: 'elevated' as const,
    requiredCapabilities: ['db.replica.disconnect'],
    command: { type: 'sql', statement: 'SELECT 1' },
    statePreservation: { before: [{ name: 'replication_slots', capture: 'pg_replication_slots' }], after: [] },
    successCriteria: { checks: [] },
    rollback: { type: 'command' as const, description: 'Re-add the replica to the primary' },
    blastRadius: {
      directComponents: ['replica-1'],
      indirectComponents: ['read-traffic'],
      maxImpact: 'reads fall back to the primary',
      cascadeRisk: 'low',
    },
    timeout: '30s',
    ...overrides,
  };
}

describe('buildRiskFraming', () => {
  it('frames an elevated system action with does/wrong/undo', () => {
    const framing = buildRiskFraming(systemStep() as never);
    expect(framing).not.toBeNull();
    expect(framing!.does).toContain('Disconnect the lagging replica');
    expect(framing!.couldGoWrong).toContain('replica-1');
    expect(framing!.couldGoWrong).toContain('reads fall back to the primary');
    expect(framing!.undo).toContain('Re-add the replica');
  });

  it('describes state capture when there is no rollback directive', () => {
    const framing = buildRiskFraming(systemStep({ rollback: undefined }) as never);
    expect(framing!.undo).toContain('captured');
  });

  it('falls back to the plan-level rollback strategy when the step has none', () => {
    const planRollback = { type: 'stepwise' as const, description: 'Each step is independently reversible via the plan rollback strategy.' };
    const framing = buildRiskFraming(systemStep({ rollback: undefined }) as never, planRollback);
    expect(framing!.undo).toBe('Each step is independently reversible via the plan rollback strategy.');
  });

  it('prefers step-level rollback over the plan-level rollback strategy', () => {
    const planRollback = { type: 'stepwise' as const, description: 'Plan-level fallback text.' };
    const framing = buildRiskFraming(systemStep() as never, planRollback);
    expect(framing!.undo).toContain('Re-add the replica');
  });

  it('returns null for routine risk', () => {
    expect(buildRiskFraming(systemStep({ riskLevel: 'routine' }) as never)).toBeNull();
  });

  it('returns null for non-system-action steps', () => {
    const step = { stepId: 'd1', type: 'diagnosis_action', name: 'x' };
    expect(buildRiskFraming(step as never)).toBeNull();
  });

  it('escalates the warning wording with risk level', () => {
    const high = buildRiskFraming(systemStep({ riskLevel: 'high' }) as never);
    const critical = buildRiskFraming(systemStep({ riskLevel: 'critical' }) as never);
    expect(high!.couldGoWrong).not.toEqual(critical!.couldGoWrong);
  });
});
