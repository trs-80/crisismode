// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * DbMigrationBackend — interface for querying database migration state,
 * connection pool health, and query activity.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

export interface MigrationStatus {
  version: string;
  name: string;
  status: 'pending' | 'running' | 'failed' | 'completed';
  startedAt: string;
  error?: string;
}

export interface ConnectionPoolStats {
  active: number;
  idle: number;
  waiting: number;
  maxConnections: number;
  utilizationPct: number;
}

export interface ActiveQuery {
  pid: number;
  query: string;
  duration: number;
  state: string;
  waitEvent?: string;
}

export interface TableLock {
  relation: string;
  lockType: string;
  granted: boolean;
  pid: number;
  query: string;
}

export interface DatabaseSizeInfo {
  totalBytes: number;
  tablespaceFree: number;
  growthRatePerHour: number;
}

export interface DbMigrationBackend extends ExecutionBackend {
  /** Get current migration state (latest migration) */
  getMigrationStatus(): Promise<MigrationStatus>;

  /** Get connection pool statistics */
  getConnectionPoolStats(): Promise<ConnectionPoolStats>;

  /** Get long-running or blocked queries */
  getActiveQueries(): Promise<ActiveQuery[]>;

  /** Get table lock information from blocked migrations */
  getTableLockInfo(): Promise<TableLock[]>;

  /** Get database size, free space, and growth rate */
  getDatabaseSize(): Promise<DatabaseSizeInfo>;

  /** Optional simulator-only state transitions */
  transition?(to: string): void;
}
