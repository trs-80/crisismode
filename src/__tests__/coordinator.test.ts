// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

const questionMock = vi.fn(async () => 'reject');

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: questionMock,
    close: () => {},
  }),
}));

import { shouldAutoApprove, requestApproval } from '../framework/coordinator.js';
import type { HumanApprovalStep } from '../types/step-types.js';
import type { RiskLevel } from '../types/common.js';

interface AutoApproveRow {
  readonly name: string;
  readonly riskLevel: RiskLevel;
  readonly trustLevel: string;
  readonly catalogCovered: boolean;
  readonly requireApprovalForAllElevated: boolean;
  readonly expected: boolean;
}

const rows: AutoApproveRow[] = [
  {
    name: 'a high-risk plan is never auto-approved, even when a catalog claims to cover it',
    riskLevel: 'high',
    trustLevel: 'full_autonomy',
    catalogCovered: true,
    requireApprovalForAllElevated: false,
    expected: false,
  },
  {
    name: 'a critical-risk plan is never auto-approved, even when a catalog claims to cover it',
    riskLevel: 'critical',
    trustLevel: 'full_autonomy',
    catalogCovered: true,
    requireApprovalForAllElevated: false,
    expected: false,
  },
  {
    name: 'a high-risk plan is not auto-approved without a catalog either',
    riskLevel: 'high',
    trustLevel: 'autopilot',
    catalogCovered: false,
    requireApprovalForAllElevated: false,
    expected: false,
  },
  {
    name: 'an elevated plan covered by a catalog is auto-approved',
    riskLevel: 'elevated',
    trustLevel: 'copilot',
    catalogCovered: true,
    requireApprovalForAllElevated: false,
    expected: true,
  },
  {
    name: 'an elevated plan under copilot trust without a catalog needs a human',
    riskLevel: 'elevated',
    trustLevel: 'copilot',
    catalogCovered: false,
    requireApprovalForAllElevated: false,
    expected: false,
  },
  {
    name: 'an elevated plan under autopilot trust without a catalog is auto-approved',
    riskLevel: 'elevated',
    trustLevel: 'autopilot',
    catalogCovered: false,
    requireApprovalForAllElevated: false,
    expected: true,
  },
  {
    name: 'requireApprovalForAllElevated beats catalog coverage',
    riskLevel: 'elevated',
    trustLevel: 'copilot',
    catalogCovered: true,
    requireApprovalForAllElevated: true,
    expected: false,
  },
  {
    name: 'requireApprovalForAllElevated beats autopilot trust',
    riskLevel: 'elevated',
    trustLevel: 'autopilot',
    catalogCovered: false,
    requireApprovalForAllElevated: true,
    expected: false,
  },
  {
    name: 'a routine plan under observe trust needs a human',
    riskLevel: 'routine',
    trustLevel: 'observe',
    catalogCovered: false,
    requireApprovalForAllElevated: false,
    expected: false,
  },
  {
    name: 'a routine plan under copilot trust is auto-approved',
    riskLevel: 'routine',
    trustLevel: 'copilot',
    catalogCovered: false,
    requireApprovalForAllElevated: false,
    expected: true,
  },
];

describe('shouldAutoApprove', () => {
  it.each(rows)(
    '$name',
    ({ riskLevel, trustLevel, catalogCovered, requireApprovalForAllElevated, expected }) => {
      expect(
        shouldAutoApprove(riskLevel, trustLevel, catalogCovered, requireApprovalForAllElevated),
      ).toBe(expected);
    },
  );
});

function makeApprovalStep(): HumanApprovalStep {
  return {
    stepId: 'step-approval',
    type: 'human_approval',
    name: 'Approve resynchronization',
    approvers: [{ role: 'dba', required: true }],
    requiredApprovals: 1,
    presentation: {
      summary: 'Approve',
      detail: 'Approve the resync',
      proposedActions: ['resync'],
      alternatives: [],
    },
    timeout: 'PT15M',
    timeoutAction: 'abort',
  };
}

describe('requestApproval', () => {
  it('always asks the human — there is no catalog bypass to pass in', async () => {
    questionMock.mockClear();
    const result = await requestApproval(makeApprovalStep());
    expect(questionMock).toHaveBeenCalledTimes(1);
    expect(result).toBe('rejected');
  });
});
