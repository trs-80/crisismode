// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { TrustLevel } from './common.js';
import type { NetworkProfile } from '../framework/network-profile.js';

export interface AgentContext {
  trigger: {
    type: 'alert' | 'health_check' | 'manual';
    source: string;
    payload: Record<string, unknown>;
    receivedAt: string;
  };
  topology: {
    source: string;
    staleness: string;
    authoritative: boolean;
    components: TopologyComponent[];
    relationships: TopologyRelationship[];
  };
  frameworkLayers: {
    execution_kernel: 'available' | 'degraded' | 'unavailable';
    safety: 'available' | 'degraded' | 'unavailable';
    coordination: 'available' | 'degraded' | 'unavailable';
    enrichment: 'available' | 'degraded' | 'unavailable';
  };
  /** Network connectivity profile — internet, hub, and target reachability. */
  network?: NetworkProfile;
  trustLevel: TrustLevel;
  trustScenarioOverrides: Record<string, TrustLevel>;
  organizationalPolicies: OrganizationalPolicies;
  preAuthorizedCatalogs: string[];
  availableExecutionContexts: string[];
  priorIncidents: unknown[];
}

export interface TopologyComponent {
  identifier: string;
  technology: string;
  version: string;
  role: string;
  reachable: boolean;
  lastHealthCheck: string;
  healthStatus: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
}

export interface TopologyRelationship {
  from: string;
  to: string;
  type: string;
  status: string;
}

export interface OrganizationalPolicies {
  maxAutonomousRiskLevel: string;
  requireApprovalAbove: string;
  requireApprovalForAllElevated: boolean;
  shellCommandsEnabled: boolean;
  approvalTimeoutMinutes: number;
  escalationDepth: number;
}
