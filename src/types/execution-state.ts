import type { RecoveryStep } from './step-types.js';

export interface ExecutionState {
  completedSteps: StepResult[];
  currentStepIndex: number;
  captures: Record<string, unknown>;
  startedAt: string;
  elapsedMs: number;
}

export interface StepResult {
  stepId: string;
  step: RecoveryStep;
  status: 'success' | 'failed' | 'skipped' | 'rolled_back';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  output?: unknown;
  error?: string;
  captureResults?: Array<{
    name: string;
    status: 'captured' | 'skipped' | 'failed';
    reason?: string;
    data?: unknown;
  }>;
}
