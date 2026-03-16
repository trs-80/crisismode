// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

export { assembleContext } from './context.js';
export type { ExecutionBackend } from './backend.js';
export { listCapabilities, getCapability, isKnownCapability } from './capability-registry.js';
export {
  resolveStepProviders,
  describeCapabilityResolutions,
  flattenProviderResolutions,
  summarizeLiveProviderReadiness,
} from './provider-registry.js';
export { buildOperatorSummary } from './operator-summary.js';
export { validatePlan } from './validator.js';
export { executeCapture, validateBlastRadius, shouldRequireApproval } from './safety.js';
export { getCatalogEntry, matchCatalog, isCatalogCovered } from './catalog.js';
export { requestApproval, shouldAutoApprove } from './coordinator.js';
export { ForensicRecorder, StreamingForensicRecorder } from './forensics.js';
export { RISK_ORDER, riskExceeds, getStepRisk, getMaxRiskIndex, derivePlanMaxRiskLevel } from './risk.js';
export { walkSteps, collectSystemActions, collectExecutionContexts } from './step-walker.js';
export { dynamicOps, makeTimestamp } from './graph-helpers.js';
export { ExecutionEngine, LegacyExecutionEngine } from './engine.js';
export { RecoveryGraphEngine } from './graph-engine.js';
export type { GraphEngineOptions } from './graph-engine.js';
export { RecoveryGraphState } from './graph-state.js';
export type { RecoveryGraphStateType } from './graph-state.js';
export type { ApprovalHandler, ApprovalDecision } from './approval-handler.js';
export { StdinApprovalHandler, HubApprovalHandler, WebhookApprovalHandler } from './approval-handler.js';
