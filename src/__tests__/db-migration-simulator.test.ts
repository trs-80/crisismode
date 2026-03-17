// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { DbMigrationSimulator } from '../agent/db-migration/simulator.js';

describe('DbMigrationSimulator', () => {
  // ---------------------------------------------------------------------------
  // getMigrationStatus()
  // ---------------------------------------------------------------------------
  describe('getMigrationStatus()', () => {
    it('reports failed in migration_stuck', async () => {
      const sim = new DbMigrationSimulator();
      const status = await sim.getMigrationStatus();
      expect(status.status).toBe('failed');
      expect(status.version).toBe('20260315_001');
      expect(status.error).toContain('Lock timeout');
    });

    it('reports running in recovering', async () => {
      const sim = new DbMigrationSimulator();
      sim.transition('recovering');
      const status = await sim.getMigrationStatus();
      expect(status.status).toBe('running');
      expect(status.error).toBeUndefined();
    });

    it('reports completed in recovered', async () => {
      const sim = new DbMigrationSimulator();
      sim.transition('recovered');
      const status = await sim.getMigrationStatus();
      expect(status.status).toBe('completed');
      expect(status.version).toBe('20260314_003');
    });
  });

  // ---------------------------------------------------------------------------
  // getConnectionPoolStats()
  // ---------------------------------------------------------------------------
  describe('getConnectionPoolStats()', () => {
    it('has high utilization in migration_stuck', async () => {
      const sim = new DbMigrationSimulator();
      const pool = await sim.getConnectionPoolStats();
      expect(pool.utilizationPct).toBe(95.0);
      expect(pool.waiting).toBe(23);
    });

    it('has moderate utilization in recovering', async () => {
      const sim = new DbMigrationSimulator();
      sim.transition('recovering');
      const pool = await sim.getConnectionPoolStats();
      expect(pool.utilizationPct).toBe(52.0);
      expect(pool.waiting).toBe(3);
    });

    it('has low utilization in recovered', async () => {
      const sim = new DbMigrationSimulator();
      sim.transition('recovered');
      const pool = await sim.getConnectionPoolStats();
      expect(pool.utilizationPct).toBe(31.0);
      expect(pool.waiting).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getActiveQueries()
  // ---------------------------------------------------------------------------
  describe('getActiveQueries()', () => {
    it('returns 4 queries in migration_stuck', async () => {
      const sim = new DbMigrationSimulator();
      const queries = await sim.getActiveQueries();
      expect(queries).toHaveLength(4);
      expect(queries[0].state).toBe('idle in transaction (aborted)');
      expect(queries[0].waitEvent).toBe('Lock');
    });

    it('returns 1 query in recovering', async () => {
      const sim = new DbMigrationSimulator();
      sim.transition('recovering');
      const queries = await sim.getActiveQueries();
      expect(queries).toHaveLength(1);
      expect(queries[0].state).toBe('active');
    });

    it('returns 0 queries in recovered', async () => {
      const sim = new DbMigrationSimulator();
      sim.transition('recovered');
      const queries = await sim.getActiveQueries();
      expect(queries).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getTableLockInfo()
  // ---------------------------------------------------------------------------
  describe('getTableLockInfo()', () => {
    it('returns locks in migration_stuck', async () => {
      const sim = new DbMigrationSimulator();
      const locks = await sim.getTableLockInfo();
      expect(locks).toHaveLength(3);
      expect(locks[0].lockType).toBe('AccessExclusiveLock');
      expect(locks[0].granted).toBe(true);
      expect(locks[1].granted).toBe(false);
    });

    it('returns no locks in recovering', async () => {
      const sim = new DbMigrationSimulator();
      sim.transition('recovering');
      const locks = await sim.getTableLockInfo();
      expect(locks).toHaveLength(0);
    });

    it('returns no locks in recovered', async () => {
      const sim = new DbMigrationSimulator();
      sim.transition('recovered');
      const locks = await sim.getTableLockInfo();
      expect(locks).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getDatabaseSize()
  // ---------------------------------------------------------------------------
  describe('getDatabaseSize()', () => {
    it('returns high growth rate in migration_stuck', async () => {
      const sim = new DbMigrationSimulator();
      const size = await sim.getDatabaseSize();
      expect(size.growthRatePerHour).toBe(536_870_912);
    });

    it('returns moderate growth rate in recovering', async () => {
      const sim = new DbMigrationSimulator();
      sim.transition('recovering');
      const size = await sim.getDatabaseSize();
      expect(size.growthRatePerHour).toBe(214_748_365);
    });

    it('returns low growth rate in recovered', async () => {
      const sim = new DbMigrationSimulator();
      sim.transition('recovered');
      const size = await sim.getDatabaseSize();
      expect(size.growthRatePerHour).toBe(107_374_182);
      expect(size.tablespaceFree).toBe(22_548_578_304);
    });
  });

  // ---------------------------------------------------------------------------
  // executeCommand()
  // ---------------------------------------------------------------------------
  describe('executeCommand()', () => {
    it('get_migration_status returns full status with sql type', async () => {
      const sim = new DbMigrationSimulator();
      const result = await sim.executeCommand({ type: 'sql', operation: 'get_migration_status' }) as Record<string, unknown>;
      expect(result).toHaveProperty('migration');
      expect(result).toHaveProperty('pool');
      expect(result).toHaveProperty('queries');
      expect(result).toHaveProperty('locks');
      expect(result).toHaveProperty('size');
    });

    it('get_migration_status also works with structured_command type', async () => {
      const sim = new DbMigrationSimulator();
      const result = await sim.executeCommand({ type: 'structured_command', operation: 'get_migration_status' }) as Record<string, unknown>;
      expect(result).toHaveProperty('migration');
    });

    it('kill_blocking_queries transitions to recovering', async () => {
      const sim = new DbMigrationSimulator();
      const result = await sim.executeCommand({ type: 'sql', operation: 'kill_blocking_queries' }) as Record<string, unknown>;
      expect(result.killedPids).toEqual([12001]);
      expect(result.released).toBe(true);
      const queries = await sim.getActiveQueries();
      expect(queries).toHaveLength(1);
    });

    it('terminate_idle_connections returns count', async () => {
      const sim = new DbMigrationSimulator();
      const result = await sim.executeCommand({ type: 'sql', operation: 'terminate_idle_connections' }) as Record<string, unknown>;
      expect(result.terminatedCount).toBe(15);
    });

    it('rollback_migration transitions to recovered', async () => {
      const sim = new DbMigrationSimulator();
      sim.transition('recovering');
      const result = await sim.executeCommand({ type: 'sql', operation: 'rollback_migration' }) as Record<string, unknown>;
      expect(result.rolledBack).toBe(true);
      expect(result.version).toBe('20260314_003');
      const status = await sim.getMigrationStatus();
      expect(status.status).toBe('completed');
    });

    it('unknown operation returns simulated: true', async () => {
      const sim = new DbMigrationSimulator();
      const result = await sim.executeCommand({ type: 'sql', operation: 'unknown' }) as Record<string, unknown>;
      expect(result.simulated).toBe(true);
    });

    it('throws on wrong command type', async () => {
      const sim = new DbMigrationSimulator();
      await expect(sim.executeCommand({ type: 'api_call', operation: 'test' }))
        .rejects.toThrow('Unsupported db-migration simulator command type: api_call');
    });
  });

  // ---------------------------------------------------------------------------
  // evaluateCheck()
  // ---------------------------------------------------------------------------
  describe('evaluateCheck()', () => {
    it('evaluates pg_isready check', async () => {
      const sim = new DbMigrationSimulator();
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'pg_isready',
        expect: { operator: 'eq', value: 1 },
      });
      expect(result).toBe(true);
    });

    it('evaluates SELECT 1 check', async () => {
      const sim = new DbMigrationSimulator();
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'SELECT 1',
        expect: { operator: 'eq', value: 1 },
      });
      expect(result).toBe(true);
    });

    it('evaluates connection_pool_utilization check', async () => {
      const sim = new DbMigrationSimulator();
      // migration_stuck: 95%
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'connection_pool_utilization',
        expect: { operator: 'gt', value: 90 },
      });
      expect(result).toBe(true);
    });

    it('evaluates active_locks check', async () => {
      const sim = new DbMigrationSimulator();
      // migration_stuck: 2 blocked (not granted) locks
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'active_locks',
        expect: { operator: 'eq', value: 2 },
      });
      expect(result).toBe(true);
    });

    it('evaluates migration_status check', async () => {
      const sim = new DbMigrationSimulator();
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'migration_status',
        expect: { operator: 'eq', value: 'failed' },
      });
      expect(result).toBe(true);
    });

    it('evaluates waiting_connections check', async () => {
      const sim = new DbMigrationSimulator();
      // migration_stuck: waiting = 23
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'waiting_connections',
        expect: { operator: 'eq', value: 23 },
      });
      expect(result).toBe(true);
    });

    it('returns true for unknown statement', async () => {
      const sim = new DbMigrationSimulator();
      const result = await sim.evaluateCheck({
        type: 'check',
        statement: 'unknown_check',
        expect: { operator: 'eq', value: 'anything' },
      });
      expect(result).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // listCapabilityProviders() & close()
  // ---------------------------------------------------------------------------
  describe('listCapabilityProviders()', () => {
    it('returns 2 providers', () => {
      const sim = new DbMigrationSimulator();
      const providers = sim.listCapabilityProviders();
      expect(providers).toHaveLength(2);
      expect(providers[0].id).toBe('db-migration-simulator-read');
      expect(providers[1].id).toBe('db-migration-simulator-write');
    });
  });

  describe('close()', () => {
    it('resolves without error', async () => {
      const sim = new DbMigrationSimulator();
      await expect(sim.close()).resolves.toBeUndefined();
    });
  });
});
