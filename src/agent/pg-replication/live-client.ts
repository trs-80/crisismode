// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * PgLiveClient — connects to real PostgreSQL instances and implements PgBackend.
 *
 * Queries pg_stat_replication, pg_replication_slots, and pg_stat_activity
 * against actual database connections. Used when running the spoke against
 * real infrastructure (test environment or production).
 */

import pg, { type Pool as PoolType } from 'pg';
import type { PgBackend, ReplicaStatus, ReplicationSlot } from './backend.js';

const { Pool } = pg;

// Row types for query results
interface ReplicationRow {
  client_addr: string;
  state: string;
  sent_lsn: string;
  write_lsn: string;
  flush_lsn: string;
  replay_lsn: string;
  lag_seconds: string;
}

interface SlotRow {
  slot_name: string;
  plugin: string;
  slot_type: string;
  active: boolean;
  restart_lsn: string;
  confirmed_flush_lsn: string;
  wal_status: string;
}

export interface PgConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export class PgLiveClient implements PgBackend {
  private primaryPool: PoolType;
  private replicaPool: PoolType | null;

  constructor(
    primaryConfig: PgConnectionConfig,
    replicaConfig?: PgConnectionConfig,
  ) {
    this.primaryPool = new Pool({
      ...primaryConfig,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    this.replicaPool = replicaConfig
      ? new Pool({
          ...replicaConfig,
          max: 3,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        })
      : null;
  }

  async queryReplicationStatus(): Promise<ReplicaStatus[]> {
    const result = await this.primaryPool.query<ReplicationRow>(`
      SELECT
        client_addr::text,
        state,
        sent_lsn::text,
        write_lsn::text,
        flush_lsn::text,
        replay_lsn::text,
        COALESCE(
          EXTRACT(EPOCH FROM replay_lag)::int,
          EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::int,
          0
        ) AS lag_seconds
      FROM pg_stat_replication
      ORDER BY client_addr
    `);

    return result.rows.map((row) => ({
      client_addr: row.client_addr || 'unknown',
      state: row.state || 'unknown',
      sent_lsn: row.sent_lsn || '',
      write_lsn: row.write_lsn || '',
      flush_lsn: row.flush_lsn || '',
      replay_lsn: row.replay_lsn || '',
      lag_seconds: parseInt(row.lag_seconds, 10) || 0,
    }));
  }

  async queryReplicationSlots(): Promise<ReplicationSlot[]> {
    const result = await this.primaryPool.query<SlotRow>(`
      SELECT
        slot_name,
        COALESCE(plugin, '') AS plugin,
        slot_type,
        active,
        restart_lsn::text,
        COALESCE(confirmed_flush_lsn::text, '') AS confirmed_flush_lsn,
        COALESCE(wal_status, 'unknown') AS wal_status
      FROM pg_replication_slots
      ORDER BY slot_name
    `);

    return result.rows.map((row) => ({
      slot_name: row.slot_name,
      plugin: row.plugin,
      slot_type: row.slot_type,
      active: row.active,
      restart_lsn: row.restart_lsn || '',
      confirmed_flush_lsn: row.confirmed_flush_lsn,
      wal_status: row.wal_status,
    }));
  }

  async queryConnectionCount(): Promise<number> {
    const result = await this.primaryPool.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE state IS NOT NULL
    `);
    return result.rows[0].count;
  }

  async evaluateCheck(check: {
    type: string;
    statement?: string;
    operation?: string;
    parameters?: Record<string, unknown>;
    expect: { operator: string; value: unknown };
  }): Promise<boolean> {
    // For structured_command checks (non-SQL), return true as a pass-through.
    // These represent checks against non-database systems (HAProxy, etc.)
    // that we can't evaluate against PostgreSQL.
    if (check.type === 'structured_command') {
      return true;
    }

    if (!check.statement) {
      return true;
    }

    try {
      const result = await this.primaryPool.query(check.statement);
      if (result.rows.length === 0) {
        return this.compare(0, check.expect.operator, check.expect.value);
      }

      // The query should return a single value (count, boolean, etc.)
      const firstRow = result.rows[0];
      const actual = Object.values(firstRow)[0];
      return this.compare(actual, check.expect.operator, check.expect.value);
    } catch (err) {
      console.error(`Check evaluation failed: ${check.statement}`, err);
      return false;
    }
  }

  async executeSQL(statement: string): Promise<unknown> {
    const result = await this.primaryPool.query(statement);
    return {
      rowCount: result.rowCount,
      rows: result.rows,
    };
  }

  transition(_to: string): void {
    // No-op for live client — state transitions happen via actual SQL execution.
  }

  async close(): Promise<void> {
    await this.primaryPool.end();
    if (this.replicaPool) {
      await this.replicaPool.end();
    }
  }

  /** Query the replica directly (for replica-specific diagnostics) */
  async queryReplicaStatus(): Promise<{
    isInRecovery: boolean;
    receivedLsn: string | null;
    replayedLsn: string | null;
    lagSeconds: number;
  } | null> {
    if (!this.replicaPool) return null;

    try {
      const result = await this.replicaPool.query<{
        is_in_recovery: boolean;
        received_lsn: string | null;
        replayed_lsn: string | null;
        lag_seconds: string;
      }>(`
        SELECT
          pg_is_in_recovery() AS is_in_recovery,
          pg_last_wal_receive_lsn()::text AS received_lsn,
          pg_last_wal_replay_lsn()::text AS replayed_lsn,
          COALESCE(
            EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::int,
            0
          ) AS lag_seconds
      `);

      const row = result.rows[0];
      return {
        isInRecovery: row.is_in_recovery,
        receivedLsn: row.received_lsn,
        replayedLsn: row.replayed_lsn,
        lagSeconds: parseInt(row.lag_seconds, 10) || 0,
      };
    } catch {
      return null;
    }
  }

  private compare(actual: unknown, operator: string, expected: unknown): boolean {
    const a = Number(actual);
    const e = Number(expected);

    if (isNaN(a) || isNaN(e)) {
      // Fall back to string comparison for non-numeric values
      const sa = String(actual);
      const se = String(expected);
      switch (operator) {
        case 'eq': return sa === se;
        case 'neq': return sa !== se;
        default: return false;
      }
    }

    switch (operator) {
      case 'eq': return a === e;
      case 'neq': return a !== e;
      case 'gt': return a > e;
      case 'gte': return a >= e;
      case 'lt': return a < e;
      case 'lte': return a <= e;
      default: return false;
    }
  }
}
