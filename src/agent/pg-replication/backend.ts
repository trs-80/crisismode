// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ExecutionBackend } from '../../framework/backend.js';

/**
 * PgBackend — the interface that both the simulator and the live client implement.
 *
 * The engine depends on the generic ExecutionBackend contract, while the agent
 * adds PostgreSQL-specific diagnosis methods on top.
 */

export interface ReplicaStatus {
  client_addr: string;
  state: string;
  sent_lsn: string;
  write_lsn: string;
  flush_lsn: string;
  replay_lsn: string;
  lag_seconds: number;
}

export interface ReplicationSlot {
  slot_name: string;
  plugin: string;
  slot_type: string;
  active: boolean;
  restart_lsn: string;
  confirmed_flush_lsn: string;
  wal_status: string;
}

export interface IdleInTransactionSession {
  pid: number;
  ageSeconds: number;
  applicationName?: string | undefined;
}

export interface ConnectionUsage {
  /** SHOW max_connections on the primary */
  max: number;
  /** Total rows in pg_stat_activity (all states) */
  total: number;
  /** Connection count grouped by pg_stat_activity.state */
  byState: Record<string, number>;
  /** idle-in-transaction sessions, oldest first */
  idleInTransactionOldest: IdleInTransactionSession[];
}

export interface PgBackend extends ExecutionBackend {
  /** Query pg_stat_replication on the primary */
  queryReplicationStatus(): Promise<ReplicaStatus[]>;

  /** Query pg_replication_slots on the primary */
  queryReplicationSlots(): Promise<ReplicationSlot[]>;

  /** Query active connection count from pg_stat_activity */
  queryConnectionCount(): Promise<number>;

  /**
   * Query whether WAL replay is paused on the replica (SELECT pg_is_wal_replay_paused()).
   * Returns null when no replica connection is available/configured.
   */
  queryReplayPaused(): Promise<boolean | null>;

  /**
   * Query connection-pool usage on the primary: total connections vs.
   * max_connections, broken down by state, plus the oldest idle-in-transaction
   * sessions (the usual cause of pool exhaustion — leaked/held transactions).
   * Returns null when the query fails (e.g. connection unavailable).
   */
  queryConnectionUsage(): Promise<ConnectionUsage | null>;

  /** Transition state (simulator) or no-op (live) */
  transition(to: string): void;
}
