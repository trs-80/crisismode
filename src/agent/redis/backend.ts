// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * RedisBackend — interface for querying Redis state.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

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

  /** Optional simulator-only state transitions */
  transition?(to: string): void;
}
