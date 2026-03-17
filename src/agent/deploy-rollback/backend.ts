// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * DeployBackend — interface for querying deployment and traffic state.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

export interface DeploymentInfo {
  sha: string;
  timestamp: string;
  status: 'running' | 'succeeded' | 'failed' | 'rolling_back' | 'rolled_back';
  author: string;
  message: string;
}

export interface TrafficDistribution {
  entries: TrafficEntry[];
}

export interface TrafficEntry {
  target: string;
  percentage: number;
}

export interface EndpointHealth {
  url: string;
  status: 'healthy' | 'degraded' | 'down';
  latencyMs: number;
  errorRate: number;
}

export interface DeployBackend extends ExecutionBackend {
  /** Get information about the currently active deployment */
  getCurrentDeployment(): Promise<DeploymentInfo>;

  /** List recent deployments ordered by timestamp descending */
  listRecentDeploys(limit: number): Promise<DeploymentInfo[]>;

  /** Get current traffic routing percentages across deploy targets */
  getTrafficDistribution(): Promise<TrafficDistribution>;

  /** Get application health check results for all monitored endpoints */
  getHealthEndpoints(): Promise<EndpointHealth[]>;

  /** Get the last known-good deployment suitable for rollback, or null if none */
  getRollbackTarget(): Promise<DeploymentInfo | null>;

  /** Optional simulator-only state transitions */
  transition?(to: string): void;
}
