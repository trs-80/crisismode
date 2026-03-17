// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * DbMigrationLiveClient — connects to a real PostgreSQL database to query
 * migration state, connection pool health, active queries, and table locks.
 *
 * Detects Prisma and Drizzle migration tables automatically.
 * Falls back to pg_stat_activity DDL detection if no ORM migration table found.
 */

import pg, { type Pool as PoolType } from 'pg';
import type {
  DbMigrationBackend,
  MigrationStatus,
  ConnectionPoolStats,
  ActiveQuery,
  TableLock,
  DatabaseSizeInfo,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';

const { Pool } = pg;

export interface DbMigrationConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Long-running query threshold in seconds (default: 60) */
  longQueryThresholdSec?: number;
}

interface MigrationRow {
  version: string;
  name: string;
  status: string;
  started_at: string;
  error: string | null;
}

interface ActiveQueryRow {
  pid: number;
  query: string;
  duration_sec: number;
  state: string;
  wait_event: string | null;
}

interface TableLockRow {
  relation: string;
  lock_type: string;
  granted: boolean;
  pid: number;
  query: string;
}

export class DbMigrationLiveClient implements DbMigrationBackend {
  private pool: PoolType;
  private readonly longQueryThresholdSec: number;

  constructor(config: DbMigrationConfig) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    this.longQueryThresholdSec = config.longQueryThresholdSec ?? 60;
  }

  async getMigrationStatus(): Promise<MigrationStatus> {
    // Try Prisma first
    const prisma = await this.tryPrismaMigration();
    if (prisma) return prisma;

    // Try Drizzle
    const drizzle = await this.tryDrizzleMigration();
    if (drizzle) return drizzle;

    // Fallback: detect DDL from pg_stat_activity
    return this.detectDdlMigration();
  }

  private async tryPrismaMigration(): Promise<MigrationStatus | null> {
    try {
      const result = await this.pool.query<MigrationRow>(`
        SELECT
          migration_name AS version,
          migration_name AS name,
          CASE
            WHEN finished_at IS NOT NULL THEN 'completed'
            WHEN rolled_back_at IS NOT NULL THEN 'failed'
            ELSE 'running'
          END AS status,
          started_at::text AS started_at,
          logs AS error
        FROM _prisma_migrations
        ORDER BY started_at DESC
        LIMIT 1
      `);
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        version: row.version,
        name: row.name,
        status: row.status as MigrationStatus['status'],
        startedAt: row.started_at,
        ...(row.error && row.status === 'failed' ? { error: row.error } : {}),
      };
    } catch {
      return null; // Table doesn't exist
    }
  }

  private async tryDrizzleMigration(): Promise<MigrationStatus | null> {
    try {
      const result = await this.pool.query<{ hash: string; created_at: string }>(`
        SELECT hash, created_at::text AS created_at
        FROM __drizzle_migrations
        ORDER BY created_at DESC
        LIMIT 1
      `);
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        version: row.hash,
        name: row.hash,
        status: 'completed',
        startedAt: row.created_at,
      };
    } catch {
      return null; // Table doesn't exist
    }
  }

  private async detectDdlMigration(): Promise<MigrationStatus> {
    // Look for DDL statements in pg_stat_activity
    const result = await this.pool.query<ActiveQueryRow>(`
      SELECT
        pid,
        query,
        EXTRACT(EPOCH FROM (now() - query_start))::int AS duration_sec,
        state,
        wait_event_type AS wait_event
      FROM pg_stat_activity
      WHERE query ~* '(CREATE|ALTER|DROP|REINDEX)\s+(TABLE|INDEX|COLUMN|CONSTRAINT)'
        AND state != 'idle'
      ORDER BY query_start ASC
      LIMIT 1
    `);

    if (result.rows.length > 0) {
      const row = result.rows[0];
      const isStuck = row.duration_sec > this.longQueryThresholdSec;
      return {
        version: `ddl-pid-${row.pid}`,
        name: row.query.slice(0, 80),
        status: isStuck ? 'failed' : 'running',
        startedAt: new Date(Date.now() - row.duration_sec * 1000).toISOString(),
        ...(isStuck ? { error: `DDL stuck for ${row.duration_sec}s — ${row.wait_event ?? 'unknown wait'}` } : {}),
      };
    }

    return {
      version: 'none',
      name: 'no active migration detected',
      status: 'completed',
      startedAt: new Date().toISOString(),
    };
  }

  async getConnectionPoolStats(): Promise<ConnectionPoolStats> {
    const result = await this.pool.query<{
      active: number;
      idle: number;
      waiting: number;
      max_connections: number;
    }>(`
      SELECT
        count(*) FILTER (WHERE state = 'active')::int AS active,
        count(*) FILTER (WHERE state = 'idle')::int AS idle,
        count(*) FILTER (WHERE wait_event_type = 'Client' AND wait_event = 'ClientRead')::int AS waiting,
        setting::int AS max_connections
      FROM pg_stat_activity
      CROSS JOIN pg_settings
      WHERE pg_settings.name = 'max_connections'
        AND pg_stat_activity.backend_type = 'client backend'
      GROUP BY setting
    `);

    if (result.rows.length === 0) {
      return { active: 0, idle: 0, waiting: 0, maxConnections: 100, utilizationPct: 0 };
    }

    const row = result.rows[0];
    const total = row.active + row.idle;
    return {
      active: row.active,
      idle: row.idle,
      waiting: row.waiting,
      maxConnections: row.max_connections,
      utilizationPct: Math.round((total / row.max_connections) * 100 * 10) / 10,
    };
  }

  async getActiveQueries(): Promise<ActiveQuery[]> {
    const result = await this.pool.query<ActiveQueryRow>(`
      SELECT
        pid,
        query,
        EXTRACT(EPOCH FROM (now() - query_start))::int AS duration_sec,
        state,
        wait_event_type AS wait_event
      FROM pg_stat_activity
      WHERE state != 'idle'
        AND pid != pg_backend_pid()
        AND EXTRACT(EPOCH FROM (now() - query_start)) > ${this.longQueryThresholdSec}
      ORDER BY query_start ASC
    `);

    return result.rows.map((row) => ({
      pid: row.pid,
      query: row.query,
      duration: row.duration_sec,
      state: row.state,
      ...(row.wait_event ? { waitEvent: row.wait_event } : {}),
    }));
  }

  async getTableLockInfo(): Promise<TableLock[]> {
    const result = await this.pool.query<TableLockRow>(`
      SELECT
        c.relname AS relation,
        l.mode AS lock_type,
        l.granted,
        a.pid,
        a.query
      FROM pg_locks l
      JOIN pg_class c ON l.relation = c.oid
      JOIN pg_stat_activity a ON l.pid = a.pid
      WHERE NOT l.granted OR l.mode IN ('AccessExclusiveLock', 'ExclusiveLock')
      ORDER BY c.relname, l.granted DESC
    `);

    return result.rows.map((row) => ({
      relation: row.relation,
      lockType: row.lock_type,
      granted: row.granted,
      pid: row.pid,
      query: row.query,
    }));
  }

  async getDatabaseSize(): Promise<DatabaseSizeInfo> {
    const result = await this.pool.query<{
      total_bytes: string;
      tablespace_free: string;
    }>(`
      SELECT
        pg_database_size(current_database())::bigint AS total_bytes,
        COALESCE(
          (SELECT pg_tablespace_size(spcname) FROM pg_tablespace WHERE spcname = 'pg_default'),
          0
        )::bigint AS tablespace_free
    `);

    const row = result.rows[0];
    return {
      totalBytes: parseInt(row.total_bytes, 10),
      tablespaceFree: parseInt(row.tablespace_free, 10),
      growthRatePerHour: 0, // Would need time-series data; report 0 for single-point query
    };
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type === 'sql' && command.statement) {
      const result = await this.pool.query(command.statement);
      return { rowCount: result.rowCount, rows: result.rows };
    }

    if (command.type === 'structured_command') {
      switch (command.operation) {
        case 'get_migration_status':
          return {
            migration: await this.getMigrationStatus(),
            pool: await this.getConnectionPoolStats(),
            queries: await this.getActiveQueries(),
            locks: await this.getTableLockInfo(),
            size: await this.getDatabaseSize(),
          };
        case 'kill_blocking_queries': {
          const queries = await this.getActiveQueries();
          const killedPids: number[] = [];
          for (const q of queries) {
            if (q.waitEvent === 'Lock' || q.duration > this.longQueryThresholdSec * 2) {
              await this.pool.query('SELECT pg_terminate_backend($1)', [q.pid]);
              killedPids.push(q.pid);
            }
          }
          return { killedPids, released: killedPids.length > 0 };
        }
        case 'terminate_idle_connections': {
          const result = await this.pool.query<{ pid: number }>(`
            SELECT pid FROM pg_stat_activity
            WHERE state = 'idle'
              AND pid != pg_backend_pid()
              AND query_start < now() - interval '5 minutes'
          `);
          let terminated = 0;
          for (const row of result.rows) {
            await this.pool.query('SELECT pg_terminate_backend($1)', [row.pid]);
            terminated++;
          }
          return { terminatedCount: terminated };
        }
        case 'rollback_migration': {
          // This is a high-risk operation — cancel the running DDL
          const migration = await this.getMigrationStatus();
          if (migration.status === 'running' || migration.status === 'failed') {
            const pidMatch = migration.version.match(/pid-(\d+)/);
            if (pidMatch) {
              await this.pool.query('SELECT pg_cancel_backend($1)', [parseInt(pidMatch[1], 10)]);
            }
          }
          return { rolledBack: true, version: migration.version };
        }
        default:
          throw new Error(`Unknown db-migration operation: ${command.operation}`);
      }
    }

    throw new Error(`Unsupported db-migration live client command type: ${command.type}`);
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt.includes('pg_isready') || stmt === 'SELECT 1') {
      try {
        await this.pool.query('SELECT 1');
        return this.compare(1, check.expect.operator, check.expect.value);
      } catch {
        return this.compare(0, check.expect.operator, check.expect.value);
      }
    }

    if (stmt.includes('connection_pool_utilization')) {
      const pool = await this.getConnectionPoolStats();
      return this.compare(pool.utilizationPct, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('active_locks')) {
      const locks = await this.getTableLockInfo();
      const blockedCount = locks.filter((l) => !l.granted).length;
      return this.compare(blockedCount, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('migration_status')) {
      const migration = await this.getMigrationStatus();
      return this.compare(migration.status, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('waiting_connections')) {
      const pool = await this.getConnectionPoolStats();
      return this.compare(pool.waiting, check.expect.operator, check.expect.value);
    }

    // Fallback: try executing as raw SQL
    if (check.statement) {
      try {
        const result = await this.pool.query(check.statement);
        if (result.rows.length === 0) {
          return this.compare(0, check.expect.operator, check.expect.value);
        }
        const actual = Object.values(result.rows[0])[0];
        return this.compare(actual, check.expect.operator, check.expect.value);
      } catch {
        return false;
      }
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'db-migration-live-read',
        kind: 'capability_provider',
        name: 'DB Migration Live Read Provider',
        maturity: 'live_validated',
        capabilities: ['db.query.read', 'db.connections.read'],
        executionContexts: ['db_read'],
        targetKinds: ['managed-database'],
        commandTypes: ['sql', 'structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
      {
        id: 'db-migration-live-write',
        kind: 'capability_provider',
        name: 'DB Migration Live Write Provider',
        maturity: 'live_validated',
        capabilities: ['db.query.read', 'db.query.write', 'db.connections.terminate', 'db.migration.rollback'],
        executionContexts: ['db_write'],
        targetKinds: ['managed-database'],
        commandTypes: ['sql', 'structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  transition(_to: string): void {
    // No-op for live client.
  }

  async discoverVersion(): Promise<string> {
    const result = await this.pool.query<{ server_version: string }>('SHOW server_version');
    return result.rows[0].server_version;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private compare(actual: unknown, operator: string, expected: unknown): boolean {
    const a = Number(actual);
    const e = Number(expected);

    if (Number.isNaN(a) || Number.isNaN(e)) {
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
