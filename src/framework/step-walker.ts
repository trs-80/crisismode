// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryStep } from '../types/step-types.js';

/**
 * Visit all steps in a plan, including conditional branch steps.
 * Calls visitor for each top-level step and for then/else branches of conditionals.
 */
export function walkSteps(steps: RecoveryStep[], visitor: (step: RecoveryStep) => void): void {
  for (const step of steps) {
    visitor(step);
    if (step.type === 'conditional') {
      visitor(step.thenStep);
      if (step.elseStep !== 'skip') visitor(step.elseStep);
    }
  }
}

/**
 * Collect all system_action steps, including those nested in conditionals.
 */
export function collectSystemActions(steps: RecoveryStep[]): Array<RecoveryStep & { type: 'system_action' }> {
  const actions: Array<RecoveryStep & { type: 'system_action' }> = [];
  walkSteps(steps, (step) => {
    if (step.type === 'system_action') actions.push(step);
  });
  return actions;
}

/**
 * Collect execution contexts from plan steps (system_action and diagnosis_action).
 */
export function collectExecutionContexts(steps: RecoveryStep[]): Set<string> {
  const contexts = new Set<string>();
  walkSteps(steps, (step) => {
    if (step.type === 'system_action' || step.type === 'diagnosis_action') {
      contexts.add(step.executionContext);
    }
  });
  return contexts;
}
