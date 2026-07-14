// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

// Re-exported from @crisismode/agent-sdk — the canonical definition (with doc
// comments) lives at packages/agent-sdk/src/types/plugin.ts. This shim
// preserves existing '../types/plugin.js' import paths.
export type {
  PluginKind,
  PluginMaturity,
  PluginMetadata,
  CapabilityActionKind,
  CapabilityDefinition,
  ProviderExecutionMode,
  CapabilityProviderDescriptor,
  CapabilityProviderResolution,
} from '@crisismode/agent-sdk';
