// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RiskLevel } from '../types/common.js';
import type { RecoveryStep } from '../types/step-types.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';

/**
 * Canonical ordering of risk levels from lowest to highest.
 * Used by risk comparison, plan validation, and approval logic.
 */
export const RISK_ORDER: RiskLevel[] = ['routine', 'elevated', 'high', 'critical'];

/**
 * Returns true if risk level `a` strictly exceeds risk level `b`.
 */
export function riskExceeds(a: RiskLevel, b: RiskLevel): boolean {
  return RISK_ORDER.indexOf(a) > RISK_ORDER.indexOf(b);
}

/**
 * Extract the risk level from a step, recursing into conditional branches.
 * Returns null for steps that don't carry a risk level.
 */
export function getStepRisk(step: RecoveryStep): RiskLevel | null {
  if (step.type === 'system_action') return step.riskLevel;
  if (step.type === 'conditional') {
    const thenRisk = getStepRisk(step.thenStep);
    const elseRisk = step.elseStep === 'skip' ? null : getStepRisk(step.elseStep);
    if (!thenRisk && !elseRisk) return null;
    if (!thenRisk) return elseRisk;
    if (!elseRisk) return thenRisk;
    return RISK_ORDER.indexOf(thenRisk) >= RISK_ORDER.indexOf(elseRisk) ? thenRisk : elseRisk;
  }
  return null;
}

/**
 * Get the maximum risk index from an array of steps.
 * Returns an index into RISK_ORDER (0 = routine, 3 = critical).
 */
export function getMaxRiskIndex(steps: RecoveryStep[]): number {
  let max = 0;
  for (const step of steps) {
    if (step.type === 'system_action') {
      max = Math.max(max, RISK_ORDER.indexOf(step.riskLevel));
    }
    if (step.type === 'conditional') {
      if (step.thenStep.type === 'system_action') {
        max = Math.max(max, RISK_ORDER.indexOf(step.thenStep.riskLevel));
      }
      if (step.elseStep !== 'skip' && step.elseStep.type === 'system_action') {
        max = Math.max(max, RISK_ORDER.indexOf(step.elseStep.riskLevel));
      }
    }
  }
  return max;
}

/**
 * Derive the maximum risk level from a recovery plan's steps.
 */
export function derivePlanMaxRiskLevel(plan: RecoveryPlan): RiskLevel {
  return RISK_ORDER[getMaxRiskIndex(plan.steps)];
}
