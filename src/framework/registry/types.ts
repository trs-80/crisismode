// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RiskLevel } from '../../types/common.js';

/**
 * Manifest format for community agent/playbook packages.
 * Lives as `crisismode-agent.json` in the root of a published package.
 */
export interface AgentPluginManifest {
  name: string;
  version: string;
  description: string;
  kind: 'agent' | 'playbook';
  entryPoint?: string;
  targetKinds: string[];
  riskProfile?: {
    maxRiskLevel: RiskLevel;
    dataLossPossible: boolean;
  };
  author?: string;
  license?: string;
  repository?: string;
  crisismode: {
    minVersion: string;
    sdkVersion?: string;
  };
}

export interface DiscoveredAgentPlugin {
  pluginDir: string;
  manifest: AgentPluginManifest;
  source: 'user' | 'project' | 'env' | 'node_modules';
}

export interface AgentPluginDiscoveryResult {
  plugins: DiscoveredAgentPlugin[];
  warnings: Array<{ path: string; reason: string }>;
}
