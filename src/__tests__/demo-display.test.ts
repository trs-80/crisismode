// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { displayPlanTable } from '../demo/display.js';
import { configure, setOutputOptions } from '../cli/output.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';

/**
 * `displayPlanTable` is the renderer `crisismode recover` and `crisismode
 * demo` actually call for plan output in human mode — not `printPlan` in
 * output.ts. It needs its own risk-framing coverage: a regression here
 * previously left it un-wired to `buildRiskFraming`, so the what/risk/undo
 * block Task 8 built was reachable only from unused code paths.
 */
function plan(): RecoveryPlan {
  return {
    apiVersion: 'v1',
    kind: 'RecoveryPlan',
    metadata: {
      planId: 'rp-test-001',
      agentName: 'test-agent',
      agentVersion: '1.0.0',
      scenario: 'test_scenario',
      createdAt: new Date().toISOString(),
      estimatedDuration: 'PT10M',
      summary: 'Test recovery plan',
      supersedes: null,
    },
    impact: {
      affectedSystems: [],
      affectedServices: [],
      estimatedUserImpact: 'none',
      dataLossRisk: 'none',
    } as unknown as RecoveryPlan['impact'],
    rollbackStrategy: { type: 'stepwise' } as unknown as RecoveryPlan['rollbackStrategy'],
    steps: [
      {
        stepId: 'step-001',
        type: 'system_action',
        name: 'Restart the service',
        description: 'Restart the target service to restore connectivity.',
        executionContext: 'primary',
        target: 'svc-1',
        riskLevel: 'elevated',
        requiredCapabilities: ['service.restart'],
        command: { type: 'sql', statement: 'SELECT 1' },
        statePreservation: { before: [{ name: 'state', capture: 'snapshot' }], after: [] },
        successCriteria: { checks: [] },
        rollback: { type: 'command', description: 'Manually restore from snapshot.' },
        blastRadius: {
          directComponents: ['svc-1'],
          indirectComponents: [],
          maxImpact: 'brief_downtime',
          cascadeRisk: 'low',
        },
        timeout: '30s',
      },
    ] as unknown as RecoveryPlan['steps'],
  };
}

describe('displayPlanTable', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('renders the what/risk/undo block for an elevated step in human mode', () => {
    configure({ mode: 'human' });
    setOutputOptions({ terse: false });

    displayPlanTable(plan());

    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(output).toContain('what:');
    expect(output).toContain('risk:');
    expect(output).toContain('undo:');
    expect(output).toContain('Restart the target service to restore connectivity.');
    expect(output).toContain('Manually restore from snapshot.');
  });

  it('omits the risk-framing block in terse mode', () => {
    configure({ mode: 'human' });
    setOutputOptions({ terse: true });

    displayPlanTable(plan());

    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(output).not.toContain('what:');
    expect(output).not.toContain('undo:');
  });

  it('omits the risk-framing block outside human mode', () => {
    configure({ mode: 'pipe' });
    setOutputOptions({ terse: false });

    displayPlanTable(plan());

    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(output).not.toContain('what:');
    expect(output).not.toContain('undo:');
  });
});
