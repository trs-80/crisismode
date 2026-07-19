// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * RedisBackend — interface for querying Redis state.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';
import type { RedisLimits } from '../../readiness/types.js';

export interface RedisInfo {
  role: 'master' | 'slave';
  connectedSlaves: number;
  usedMemoryBytes: number;
  maxMemoryBytes: number;
  memoryUsagePercent: number;
  connectedClients: number;
  blockedClients: number;
  evictedKeys: number;
  hitRate: number;
  uptimeSeconds: number;
}

export interface RedisSlaveInfo {
  id: string;
  ip: string;
  port: number;
  state: string;
  offset: number;
  lag: number;
}

export interface RedisSlowlogEntry {
  id: number;
  timestamp: number;
  durationMicros: number;
  command: string;
}

export interface RedisClusterNodeInfo {
  id: string;
  address: string;
  role: 'master' | 'slave';
  flags: string[];
  linkState: 'connected' | 'disconnected';
  slots: string;
}

export interface RedisClusterInfo {
  /** Whether this Redis instance is part of a cluster */
  enabled: boolean;
  /** Cluster state: 'ok' or 'fail' */
  state: 'ok' | 'fail';
  /** Total hash slots assigned */
  slotsAssigned: number;
  /** Hash slots in ok state */
  slotsOk: number;
  /** Hash slots in pfail state */
  slotsPfail: number;
  /** Hash slots in fail state */
  slotsFail: number;
  /** Known cluster nodes */
  knownNodes: number;
  /** Cluster size (master count) */
  clusterSize: number;
  /** Node details from CLUSTER NODES */
  nodes: RedisClusterNodeInfo[];
}

export interface RedisBackend extends ExecutionBackend {
  /** Get server INFO (memory, connections, replication) */
  getInfo(): Promise<RedisInfo>;

  /** Get connected replica details */
  getSlaves(): Promise<RedisSlaveInfo[]>;

  /** Get recent slowlog entries */
  getSlowlog(count: number): Promise<RedisSlowlogEntry[]>;

  /** Get count of keys matching a pattern */
  getKeyCount(): Promise<number>;

  /** Get current memory fragmentation ratio */
  getFragmentationRatio(): Promise<number>;

  /** Get cluster info (returns enabled: false for standalone instances) */
  getClusterInfo(): Promise<RedisClusterInfo>;

  /** Declared server limits + current usage for capacity ceilings. Null when unreadable. */
  queryServerLimits?(): Promise<RedisLimits | null>;

  /** Optional simulator-only state transitions */
  transition?(to: string): void;
}
