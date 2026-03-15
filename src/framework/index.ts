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
export { ForensicRecorder } from './forensics.js';
export { ExecutionEngine } from './engine.js';
