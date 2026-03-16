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

export interface PgBackend extends ExecutionBackend {
  /** Query pg_stat_replication on the primary */
  queryReplicationStatus(): Promise<ReplicaStatus[]>;

  /** Query pg_replication_slots on the primary */
  queryReplicationSlots(): Promise<ReplicationSlot[]>;

  /** Query active connection count from pg_stat_activity */
  queryConnectionCount(): Promise<number>;

  /** Transition state (simulator) or no-op (live) */
  transition(to: string): void;
}
