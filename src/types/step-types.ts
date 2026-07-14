// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

// Re-exported from @crisismode/agent-sdk — the canonical definition (with doc
// comments) lives at packages/agent-sdk/src/types/step-types.ts. This shim
// preserves existing '../types/step-types.js' import paths.
export type {
  SystemActionStep,
  DiagnosisActionStep,
  HumanNotificationStep,
  HumanApprovalStep,
  CheckpointStep,
  ReplanningCheckpointStep,
  ConditionalStep,
  RecoveryStep,
} from '@crisismode/agent-sdk';
