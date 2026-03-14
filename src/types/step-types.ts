// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type {
  BlastRadius,
  Command,
  CaptureDirective,
  RetryPolicy,
  RollbackDirective,
  Recipient,
  Approver,
  PreCondition,
  SuccessCriteria,
  StatePreservation,
  CheckExpression,
  RiskLevel,
  TimeoutAction,
} from './common.js';

export interface SystemActionStep {
  stepId: string;
  type: 'system_action';
  name: string;
  description?: string;
  executionContext: string;
  target: string;
  riskLevel: RiskLevel;
  command: Command;
  preConditions?: PreCondition[];
  statePreservation: StatePreservation;
  successCriteria: SuccessCriteria;
  rollback?: RollbackDirective;
  blastRadius: BlastRadius;
  timeout: string;
  retryPolicy?: RetryPolicy;
}

export interface DiagnosisActionStep {
  stepId: string;
  type: 'diagnosis_action';
  name: string;
  description?: string;
  executionContext: string;
  target: string;
  command: Command;
  outputCapture?: {
    name: string;
    format: string;
    availableTo: string;
  };
  timeout: string;
}

export interface HumanNotificationStep {
  stepId: string;
  type: 'human_notification';
  name: string;
  recipients: Recipient[];
  message: {
    summary: string;
    detail: string;
    contextReferences?: string[];
    actionRequired: boolean;
  };
  channel: string;
}

export interface HumanApprovalStep {
  stepId: string;
  type: 'human_approval';
  name: string;
  description?: string;
  approvers: Approver[];
  requiredApprovals: number;
  presentation: {
    summary: string;
    detail: string;
    contextReferences?: string[];
    proposedActions: string[];
    riskSummary?: string;
    alternatives: Array<{
      action: string;
      description: string;
    }>;
  };
  timeout: string;
  timeoutAction: TimeoutAction;
  escalateTo?: {
    role: string;
    message: string;
  };
}

export interface CheckpointStep {
  stepId: string;
  type: 'checkpoint';
  name: string;
  description?: string;
  stateCaptures: CaptureDirective[];
}

export interface ReplanningCheckpointStep {
  stepId: string;
  type: 'replanning_checkpoint';
  name: string;
  description?: string;
  fastReplan: boolean;
  replanTimeout: string;
  diagnosticCaptures?: CaptureDirective[];
}

type NonConditionalStep =
  | SystemActionStep
  | DiagnosisActionStep
  | HumanNotificationStep
  | HumanApprovalStep
  | CheckpointStep
  | ReplanningCheckpointStep;

export interface ConditionalStep {
  stepId: string;
  type: 'conditional';
  name: string;
  condition: {
    description: string;
    check: CheckExpression;
  };
  thenStep: NonConditionalStep;
  elseStep: NonConditionalStep | 'skip';
}

export type RecoveryStep =
  | SystemActionStep
  | DiagnosisActionStep
  | HumanNotificationStep
  | HumanApprovalStep
  | CheckpointStep
  | ReplanningCheckpointStep
  | ConditionalStep;
