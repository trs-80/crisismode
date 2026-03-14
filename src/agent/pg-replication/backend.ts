// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * PgBackend — the interface that both the simulator and the live client implement.
 *
 * The engine and agent depend on this interface, not on a concrete implementation.
 * This allows swapping between simulated execution (demo, tests) and real
 * PostgreSQL connections without changing any framework or agent code.
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

export interface PgBackend {
  /** Query pg_stat_replication on the primary */
  queryReplicationStatus(): Promise<ReplicaStatus[]>;

  /** Query pg_replication_slots on the primary */
  queryReplicationSlots(): Promise<ReplicationSlot[]>;

  /** Query active connection count from pg_stat_activity */
  queryConnectionCount(): Promise<number>;

  /** Evaluate a check expression (precondition or success criteria) */
  evaluateCheck(check: {
    type: string;
    statement?: string;
    operation?: string;
    parameters?: Record<string, unknown>;
    expect: { operator: string; value: unknown };
  }): Promise<boolean>;

  /** Execute a SQL statement (for system_action steps) */
  executeSQL(statement: string): Promise<unknown>;

  /** Transition state (simulator) or no-op (live) */
  transition(to: string): void;

  /** Clean up connections */
  close(): Promise<void>;
}
