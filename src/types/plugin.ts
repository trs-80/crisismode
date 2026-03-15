// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { Command } from './common.js';

export type PluginKind =
  | 'domain_pack'
  | 'scenario_module'
  | 'capability_provider'
  | 'signal_adapter'
  | 'evidence_provider';

export type PluginMaturity =
  | 'experimental'
  | 'simulator_only'
  | 'dry_run_only'
  | 'live_validated'
  | 'production_certified';

export interface PluginMetadata {
  id: string;
  kind: PluginKind;
  maturity: PluginMaturity;
  compatibilityMode?: 'recovery_agent';
}

export type CapabilityActionKind = 'read' | 'mutate' | 'check' | 'capture';

export interface CapabilityDefinition {
  id: string;
  actionKind: CapabilityActionKind;
  description: string;
  targetKinds: string[];
  manualFallback?: string;
}

export type ProviderExecutionMode = 'dry-run' | 'execute';

export interface CapabilityProviderDescriptor {
  id: string;
  kind: 'capability_provider';
  name: string;
  maturity: PluginMaturity;
  capabilities: string[];
  executionContexts: string[];
  targetKinds: string[];
  commandTypes: Command['type'][];
  supportsDryRun: boolean;
  supportsExecute: boolean;
}

export interface CapabilityProviderResolution {
  capability: string;
  resolved: boolean;
  providerId?: string;
  reason?: string;
}
