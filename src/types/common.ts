// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

// Re-exported from @crisismode/agent-sdk — the canonical definition (with doc
// comments) lives at packages/agent-sdk/src/types/common.ts. This shim
// preserves existing '../types/common.js' import paths.
export type {
  ExecutionMode,
  RiskLevel,
  TrustLevel,
  CapturePolicy,
  CaptureCost,
  CaptureType,
  CascadeRisk,
  Urgency,
  TimeoutAction,
  CheckExpression,
  Command,
  BlastRadius,
  CaptureDirective,
  RetryPolicy,
  RollbackDirective,
  Recipient,
  Approver,
  PreCondition,
  SuccessCriteria,
  StatePreservation,
} from '@crisismode/agent-sdk';
