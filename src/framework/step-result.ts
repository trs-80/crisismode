// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryStep } from '../types/step-types.js';
import type { StepResult } from '../types/execution-state.js';

/**
 * Build a StepResult from a step, status, timing, and optional overrides.
 * Shared between the legacy ExecutionEngine and the graph-based engine.
 */
export function makeStepResult(
  step: RecoveryStep,
  status: StepResult['status'],
  startedAt: string,
  startTime: number,
  extra?: Partial<StepResult>,
): StepResult {
  return {
    stepId: step.stepId,
    step,
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    ...extra,
  };
}
