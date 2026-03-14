import type { AgentContext } from './agent-context.js';
import type { DiagnosisResult } from './diagnosis-result.js';
import type { RecoveryPlan } from './recovery-plan.js';
import type { StepResult } from './execution-state.js';

export interface ForensicRecord {
  recordId: string;
  createdAt: string;
  completedAt: string;
  completeness: 'complete' | 'partial' | 'minimal';
  context: AgentContext;
  diagnosis: DiagnosisResult;
  plans: RecoveryPlan[];
  executionLog: ExecutionLogEntry[];
  stepResults: StepResult[];
  captures: Array<{
    name: string;
    captureType: string;
    status: 'captured' | 'skipped' | 'failed';
    reason?: string;
    timestamp: string;
    data?: unknown;
  }>;
  summary: {
    totalSteps: number;
    completedSteps: number;
    failedSteps: number;
    skippedSteps: number;
    totalDurationMs: number;
    capturesAttempted: number;
    capturesSucceeded: number;
    capturesSkipped: number;
    catalogMatchUsed: boolean;
    replanCount: number;
    outcome: 'success' | 'partial_success' | 'failed' | 'aborted';
  };
}

export interface ExecutionLogEntry {
  timestamp: string;
  type:
    | 'step_start'
    | 'step_complete'
    | 'step_failed'
    | 'precondition_check'
    | 'success_check'
    | 'capture_attempt'
    | 'capture_result'
    | 'approval_request'
    | 'approval_received'
    | 'approval_auto'
    | 'notification_sent'
    | 'conditional_eval'
    | 'replan_start'
    | 'replan_result'
    | 'validation_pass'
    | 'validation_fail'
    | 'catalog_match'
    | 'info';
  stepId?: string;
  message: string;
  data?: Record<string, unknown>;
}
