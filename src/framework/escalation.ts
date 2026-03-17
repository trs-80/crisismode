// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Five-level progressive escalation model.
 *
 * Maps CrisisMode's internal risk levels and step types to a user-facing
 * escalation ladder that communicates what actions are being taken and
 * what gates the next level.
 *
 * Levels:
 *   1. Observe  — read-only health checks, no system interaction
 *   2. Diagnose — read-only queries against live systems
 *   3. Suggest  — generate recovery plans without executing
 *   4. Repair (safe)       — execute routine/elevated risk actions
 *   5. Repair (destructive) — execute high/critical risk actions
 */

import type { RiskLevel } from '../types/common.js';
import type { RecoveryStep } from '../types/step-types.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import { getStepRisk } from './risk.js';

export type EscalationLevel = 1 | 2 | 3 | 4 | 5;

export interface EscalationInfo {
  level: EscalationLevel;
  label: string;
  description: string;
  gate: string;
}

const ESCALATION_LABELS: Record<EscalationLevel, string> = {
  1: 'Observe',
  2: 'Diagnose',
  3: 'Suggest',
  4: 'Repair (safe)',
  5: 'Repair (destructive)',
};

const ESCALATION_DESCRIPTIONS: Record<EscalationLevel, string> = {
  1: 'Read-only health checks — no system interaction',
  2: 'Read-only queries against live systems',
  3: 'Generate recovery plans without executing',
  4: 'Execute routine and elevated-risk recovery actions',
  5: 'Execute high and critical-risk recovery actions',
};

const ESCALATION_GATES: Record<EscalationLevel, string> = {
  1: 'Always available',
  2: 'Requires network access to target systems',
  3: 'Requires diagnosis findings',
  4: 'Requires --execute flag and plan approval',
  5: 'Requires --execute flag, human approval, and elevated permissions',
};

/**
 * Get full escalation info for a given level.
 */
export function getEscalationInfo(level: EscalationLevel): EscalationInfo {
  return {
    level,
    label: ESCALATION_LABELS[level],
    description: ESCALATION_DESCRIPTIONS[level],
    gate: ESCALATION_GATES[level],
  };
}

/**
 * Determine the escalation level required for a recovery step.
 */
export function stepEscalationLevel(step: RecoveryStep): EscalationLevel {
  switch (step.type) {
    case 'diagnosis_action':
      return 2;
    case 'human_notification':
    case 'human_approval':
    case 'checkpoint':
    case 'replanning_checkpoint':
      return 3;
    case 'system_action': {
      const risk = step.riskLevel;
      return riskToEscalation(risk);
    }
    case 'conditional': {
      const thenLevel = stepEscalationLevel(step.thenStep);
      const elseLevel = step.elseStep === 'skip' ? 1 : stepEscalationLevel(step.elseStep);
      return Math.max(thenLevel, elseLevel) as EscalationLevel;
    }
  }
}

/**
 * Map a risk level to the corresponding escalation level.
 */
export function riskToEscalation(risk: RiskLevel): EscalationLevel {
  switch (risk) {
    case 'routine':
    case 'elevated':
      return 4;
    case 'high':
    case 'critical':
      return 5;
  }
}

/**
 * Determine the maximum escalation level required for a recovery plan.
 */
export function planEscalationLevel(plan: RecoveryPlan): EscalationLevel {
  if (plan.steps.length === 0) return 3; // empty plan is still a suggestion
  let max: EscalationLevel = 3; // minimum for any plan is "Suggest"
  for (const step of plan.steps) {
    const level = stepEscalationLevel(step);
    if (level > max) max = level;
  }
  return max;
}

/**
 * Get all five escalation levels with their info.
 */
export function allEscalationLevels(): EscalationInfo[] {
  return ([1, 2, 3, 4, 5] as EscalationLevel[]).map(getEscalationInfo);
}
