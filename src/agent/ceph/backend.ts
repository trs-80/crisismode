// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * CephBackend — interface for querying Ceph cluster state.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

export interface CephClusterStatus {
  health: 'HEALTH_OK' | 'HEALTH_WARN' | 'HEALTH_ERR';
  monCount: number;
  osdCount: number;
  osdUp: number;
  osdIn: number;
  pgCount: number;
  pgHealthy: number;
  pgDegraded: number;
  pgRecovering: number;
  usedBytes: number;
  totalBytes: number;
  usagePercent: number;
}

export interface CephOSDInfo {
  id: number;
  name: string;
  host: string;
  status: 'up' | 'down';
  inCluster: boolean;
  weight: number;
  reweight: number;
  usedBytes: number;
  totalBytes: number;
  utilization: number;
}

export interface CephPGStatus {
  pgId: string;
  state: string;
  up: number[];
  acting: number[];
  objectCount: number;
}

export interface CephPoolStats {
  name: string;
  id: number;
  size: number;
  minSize: number;
  pgCount: number;
  usedBytes: number;
  maxBytes: number;
  percentUsed: number;
}

export interface CephHealthDetail {
  checks: Array<{
    type: string;
    severity: 'HEALTH_WARN' | 'HEALTH_ERR';
    summary: string;
    detail: string;
  }>;
}

export interface CephBackend extends ExecutionBackend {
  /** Get overall cluster health and capacity */
  getClusterStatus(): Promise<CephClusterStatus>;

  /** Get OSD tree with status and utilization */
  getOSDTree(): Promise<CephOSDInfo[]>;

  /** Get placement group status */
  getPGStatus(): Promise<CephPGStatus[]>;

  /** Get per-pool statistics */
  getPoolStats(): Promise<CephPoolStats[]>;

  /** Get detailed health check information */
  getHealthDetail(): Promise<CephHealthDetail>;

  /** Optional simulator-only state transitions */
  transition?(to: string): void;
}
