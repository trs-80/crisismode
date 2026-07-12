// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

// Re-exported from @crisismode/agent-sdk — the canonical definition (with doc
// comments) lives at packages/agent-sdk/src/types/health.ts. This shim
// preserves existing '../types/health.js' import paths.
export type {
  HealthStatus,
  HealthSignalStatus,
  HealthSignal,
  HealthAssessment,
  OperatorActionRequired,
  AutomationStatus,
  ExecuteReadiness,
  OperatorSummary,
} from '@crisismode/agent-sdk';
