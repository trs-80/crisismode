// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

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

export type SimulatorState = 'migration_stuck' | 'recovering' | 'recovered';

export class DbMigrationSimulator implements DbMigrationBackend {
  private state: SimulatorState = 'migration_stuck';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async getMigrationStatus(): Promise<MigrationStatus> {
    switch (this.state) {
      case 'migration_stuck':
        return {
          version: '20260315_001',
          name: 'add_indexes_to_orders_table',
          status: 'failed',
          startedAt: new Date(Date.now() - 3_600_000).toISOString(),
          error: 'Lock timeout: could not acquire AccessExclusiveLock on relation "orders"',
        };
      case 'recovering':
        return {
          version: '20260315_001',
          name: 'add_indexes_to_orders_table',
          status: 'running',
          startedAt: new Date(Date.now() - 300_000).toISOString(),
        };
      case 'recovered':
        return {
          version: '20260314_003',
          name: 'add_status_column_to_shipments',
          status: 'completed',
          startedAt: new Date(Date.now() - 7_200_000).toISOString(),
        };
    }
  }

  async getConnectionPoolStats(): Promise<ConnectionPoolStats> {
    switch (this.state) {
      case 'migration_stuck':
        return {
          active: 95,
          idle: 2,
          waiting: 23,
          maxConnections: 100,
          utilizationPct: 95.0,
        };
      case 'recovering':
        return {
          active: 52,
          idle: 28,
          waiting: 3,
          maxConnections: 100,
          utilizationPct: 52.0,
        };
      case 'recovered':
        return {
          active: 31,
          idle: 44,
          waiting: 0,
          maxConnections: 100,
          utilizationPct: 31.0,
        };
    }
  }

  async getActiveQueries(): Promise<ActiveQuery[]> {
    if (this.state === 'migration_stuck') {
      return [
        {
          pid: 12001,
          query: 'CREATE INDEX CONCURRENTLY idx_orders_customer_id ON orders (customer_id)',
          duration: 3540,
          state: 'idle in transaction (aborted)',
          waitEvent: 'Lock',
        },
        {
          pid: 12045,
          query: 'SELECT * FROM orders WHERE customer_id = $1',
          duration: 1820,
          state: 'active',
          waitEvent: 'Lock',
        },
        {
          pid: 12078,
          query: 'UPDATE orders SET status = $1 WHERE id = $2',
          duration: 1650,
          state: 'active',
          waitEvent: 'Lock',
        },
        {
          pid: 12102,
          query: 'INSERT INTO orders (customer_id, total) VALUES ($1, $2)',
          duration: 920,
          state: 'active',
          waitEvent: 'Lock',
        },
      ];
    }
    if (this.state === 'recovering') {
      return [
        {
          pid: 12045,
          query: 'SELECT * FROM orders WHERE customer_id = $1',
          duration: 12,
          state: 'active',
        },
      ];
    }
    return [];
  }

  async getTableLockInfo(): Promise<TableLock[]> {
    if (this.state === 'migration_stuck') {
      return [
        {
          relation: 'orders',
          lockType: 'AccessExclusiveLock',
          granted: true,
          pid: 12001,
          query: 'CREATE INDEX CONCURRENTLY idx_orders_customer_id ON orders (customer_id)',
        },
        {
          relation: 'orders',
          lockType: 'RowShareLock',
          granted: false,
          pid: 12045,
          query: 'SELECT * FROM orders WHERE customer_id = $1',
        },
        {
          relation: 'orders',
          lockType: 'RowExclusiveLock',
          granted: false,
          pid: 12078,
          query: 'UPDATE orders SET status = $1 WHERE id = $2',
        },
      ];
    }
    return [];
  }

  async getDatabaseSize(): Promise<DatabaseSizeInfo> {
    switch (this.state) {
      case 'migration_stuck':
        return {
          totalBytes: 107_374_182_400, // ~100GB
          tablespaceFree: 21_474_836_480, // ~20GB
          growthRatePerHour: 536_870_912, // ~512MB/hr
        };
      case 'recovering':
        return {
          totalBytes: 107_374_182_400,
          tablespaceFree: 21_474_836_480,
          growthRatePerHour: 214_748_365, // ~200MB/hr
        };
      case 'recovered':
        return {
          totalBytes: 107_374_182_400,
          tablespaceFree: 22_548_578_304, // ~21GB
          growthRatePerHour: 107_374_182, // ~100MB/hr
        };
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'sql' && command.type !== 'structured_command') {
      throw new Error(`Unsupported db-migration simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'get_migration_status':
        return {
          migration: await this.getMigrationStatus(),
          pool: await this.getConnectionPoolStats(),
          queries: await this.getActiveQueries(),
          locks: await this.getTableLockInfo(),
          size: await this.getDatabaseSize(),
        };
      case 'kill_blocking_queries':
        this.transition('recovering');
        return { killedPids: [12001], released: true };
      case 'terminate_idle_connections':
        return { terminatedCount: 15 };
      case 'rollback_migration':
        this.transition('recovered');
        return { rolledBack: true, version: '20260314_003' };
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt.includes('pg_isready') || stmt === 'SELECT 1') {
      return this.compare(1, check.expect.operator, check.expect.value);
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

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'db-migration-simulator-read',
        kind: 'capability_provider',
        name: 'DB Migration Simulator Read Provider',
        maturity: 'simulator_only',
        capabilities: ['db.query.read', 'db.connections.read'],
        executionContexts: ['db_read'],
        targetKinds: ['managed-database'],
        commandTypes: ['sql', 'structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
      {
        id: 'db-migration-simulator-write',
        kind: 'capability_provider',
        name: 'DB Migration Simulator Write Provider',
        maturity: 'simulator_only',
        capabilities: ['db.query.read', 'db.query.write', 'db.connections.terminate', 'db.migration.rollback'],
        executionContexts: ['db_write'],
        targetKinds: ['managed-database'],
        commandTypes: ['sql', 'structured_command'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {}

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
