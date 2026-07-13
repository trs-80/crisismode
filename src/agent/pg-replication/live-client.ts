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
import type { PgBackend, ReplicaStatus, ReplicationSlot, ConnectionUsage } from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

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
        host(client_addr) AS client_addr,
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

  /**
   * Query connection-pool usage on the primary: total connections vs.
   * max_connections, broken down by state, plus the oldest idle-in-transaction
   * sessions (the usual cause of pool exhaustion). Returns null rather than
   * throwing so a transient failure here doesn't break the rest of diagnose().
   */
  async queryConnectionUsage(): Promise<ConnectionUsage | null> {
    try {
      const totalResult = await this.primaryPool.query<{ total: number; max_connections: number }>(
        "SELECT count(*)::int AS total, current_setting('max_connections')::int AS max_connections FROM pg_stat_activity;",
      );
      const totalRow = totalResult.rows[0];
      if (!totalRow) return null;

      const byStateResult = await this.primaryPool.query<{ state: string | null; count: number }>(
        'SELECT state, count(*)::int AS count FROM pg_stat_activity GROUP BY state;',
      );
      const byState: Record<string, number> = {};
      for (const row of byStateResult.rows) {
        byState[row.state ?? 'unknown'] = row.count;
      }

      const idleResult = await this.primaryPool.query<{ pid: number; age_seconds: number; application_name: string | null }>(`
        SELECT pid, COALESCE(EXTRACT(EPOCH FROM (now() - state_change))::int, 0) AS age_seconds, application_name
        FROM pg_stat_activity
        WHERE state = 'idle in transaction'
        ORDER BY age_seconds DESC
      `);
      const idleInTransactionOldest = idleResult.rows.map((row) => ({
        pid: row.pid,
        ageSeconds: row.age_seconds,
        applicationName: row.application_name ?? undefined,
      }));

      return {
        max: totalRow.max_connections,
        total: totalRow.total,
        byState,
        idleInTransactionOldest,
      };
    } catch {
      return null;
    }
  }

  /**
   * Select which pool a command/check targets. Steps that must run against the
   * replica (e.g. pg_wal_replay_resume(), which only exists in recovery mode)
   * set `parameters.node === 'replica'`; everything else defaults to the primary.
   */
  private poolFor(parameters?: Record<string, unknown>): PoolType {
    if (parameters?.node === 'replica') {
      if (!this.replicaPool) {
        throw new Error("Step targets node='replica' but no replica connection is configured");
      }
      return this.replicaPool;
    }
    return this.primaryPool;
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    if (check.type === 'structured_command') {
      return false;
    }

    if (!check.statement) {
      return false;
    }

    try {
      const pool = this.poolFor(check.parameters);
      const result = await pool.query(check.statement);
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

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type === 'sql' && command.statement) {
      const pool = this.poolFor(command.parameters);
      const result = await pool.query(command.statement);
      return {
        rowCount: result.rowCount,
        rows: result.rows,
      };
    }

    throw new Error(
      `Unsupported PostgreSQL live command: ${command.type}${command.operation ? `:${command.operation}` : ''}`,
    );
  }

  transition(_to: string): void {
    // No-op for live client — state transitions happen via actual SQL execution.
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'postgresql-live-sql',
        kind: 'capability_provider',
        name: 'PostgreSQL Live SQL Provider',
        maturity: 'live_validated',
        capabilities: [
          'db.query.read',
          'db.query.write',
          'db.replica.disconnect',
          'db.replication_slot.drop',
          'db.replication_slot.create',
          'db.wal_replay.resume',
          'db.connections.terminate',
        ],
        executionContexts: ['postgresql_read', 'postgresql_write'],
        targetKinds: ['postgresql'],
        commandTypes: ['sql'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async discoverVersion(): Promise<string> {
    const result = await this.primaryPool.query<{ server_version: string }>('SHOW server_version');
    return result.rows[0].server_version;
  }

  async close(): Promise<void> {
    await this.primaryPool.end();
    if (this.replicaPool) {
      await this.replicaPool.end();
    }
  }

  /**
   * Query whether WAL replay is paused on the replica (SELECT pg_is_wal_replay_paused()).
   * Returns null when no replica connection is configured or reachable.
   */
  async queryReplayPaused(): Promise<boolean | null> {
    if (!this.replicaPool) return null;

    try {
      const result = await this.replicaPool.query<{ paused: boolean }>(
        'SELECT pg_is_wal_replay_paused() AS paused;',
      );
      return result.rows[0]?.paused ?? null;
    } catch {
      return null;
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
