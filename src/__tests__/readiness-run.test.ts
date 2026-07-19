// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect, vi } from 'vitest';
import { runRules, connectAndRunReadiness } from '../readiness/run.js';
import { buildReport } from '../readiness/report.js';
import { allRules } from '../readiness/rules/index.js';
import type { ReadinessRule, ReadinessSources, ReadinessContext } from '../readiness/types.js';
import type { TargetConfig } from '../config/schema.js';

const ctx = {
  serverless: false,
  target: { host: 'db', port: 5432 },
  stack: { appStack: { framework: null } },
} as ReadinessContext;
const sources: ReadinessSources = {
  connectionUsage: async () => ({ max: 100, total: 10, byState: {}, idleInTransactionOldest: [] }),
  tableStats: async () => [],
  statementStats: async () => null,
};

const PG_TARGET: TargetConfig = {
  name: 'reachable',
  kind: 'postgresql',
  primary: { host: 'db', port: 5432 },
};

const REDIS_TARGET: TargetConfig = {
  name: 'redis',
  kind: 'redis',
  primary: { host: 'redis-host', port: 6379 },
};

function okFakePgClient() {
  return {
    queryConnectionCount: async () => 1,
    queryConnectionUsage: async () => ({ max: 100, total: 10, byState: {}, idleInTransactionOldest: [] }),
    queryTableStats: async () => [],
    queryStatementStats: async () => null,
    queryStatementAggregate: async () => null,
    close: async () => {},
  };
}

describe('runRules', () => {
  it('skips rules whose applicable() is false', async () => {
    const findings = await runRules(allRules, sources, { ...ctx, serverless: false });
    expect(findings.some((f) => f.ruleId === 'serverless-pooling')).toBe(false);
  });

  it('a throwing rule becomes an unknown finding, not a crash', async () => {
    const bad: ReadinessRule = {
      id: 'bad', title: 'Bad',
      applicable: () => true,
      evaluate: async () => { throw new Error('boom'); },
    };
    const findings = await runRules([bad], sources, ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe('unknown');
    expect(findings[0]?.reason).toContain('boom');
  });

  it('registry contains the six v1 rules', () => {
    expect(allRules.map((r) => r.id).sort()).toEqual([
      'connection-headroom', 'connection-limit-tier', 'long-transactions',
      'missing-index', 'serverless-pooling', 'slow-queries',
    ]);
  });
});

describe('connectAndRunReadiness', () => {
  it('closes the pg client even when the connectivity probe fails', async () => {
    const closeSpy = vi.fn(async () => {});
    const target: TargetConfig = {
      name: 'unreachable',
      kind: 'postgresql',
      primary: { host: 'unreachable-host', port: 5432 },
    };

    const report = await connectAndRunReadiness(target, ctx, () => ({
      queryConnectionCount: async () => { throw new Error('connection refused'); },
      queryConnectionUsage: async () => null,
      queryTableStats: async () => null,
      queryStatementStats: async () => null,
      queryStatementAggregate: async () => null,
      close: closeSpy,
    }));

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(report.verdict).toBe('unknown');
    expect(report.findings[0]?.reason).toContain('connection refused');
  });

  it('closes the pg client after a successful run', async () => {
    const closeSpy = vi.fn(async () => {});

    await connectAndRunReadiness(PG_TARGET, ctx, () => ({
      queryConnectionCount: async () => 1,
      queryConnectionUsage: async () => ({ max: 100, total: 10, byState: {}, idleInTransactionOldest: [] }),
      queryTableStats: async () => [],
      queryStatementStats: async () => null,
      queryStatementAggregate: async () => null,
      close: closeSpy,
    }));

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('report carries ceilings and weakLink without affecting score', async () => {
    const closeSpy = vi.fn(async () => {});
    const fake = {
      queryConnectionCount: async () => 1,
      queryConnectionUsage: async () => ({ max: 100, total: 10, byState: {}, idleInTransactionOldest: [] }),
      queryTableStats: async () => null,
      queryStatementStats: async () => null,
      queryStatementAggregate: async () => ({ meanMs: 50, calls: 1000 }),
      close: closeSpy,
    };
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => fake);
    expect(report.ceilings?.find((c) => c.id === 'db-throughput')?.value).toBe(2000);
    expect(report.weakLink?.binding).toBe('db-throughput');
    expect(report.score).toBe(buildReport(report.findings).score); // ceilings never move the score
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('redis probe failure omits the ceiling without failing the report', async () => {
    const redisClose = vi.fn(async () => {});
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => okFakePgClient(), {
      createRedisClient: () => ({ queryServerLimits: async () => { throw new Error('conn refused'); }, close: redisClose }),
      redisTarget: REDIS_TARGET,
    });
    expect(report.verdict).not.toBe(undefined);
    expect(report.ceilingsOmitted?.some((o) => o.id === 'redis-limits')).toBe(true);
    expect(redisClose).toHaveBeenCalledTimes(1);
  });

  it('a throwing redis client factory omits the ceiling without failing the report', async () => {
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => okFakePgClient(), {
      createRedisClient: () => { throw new Error('bad credential ref'); },
      redisTarget: REDIS_TARGET,
    });
    expect(report.verdict).not.toBe(undefined);
    expect(report.ceilingsOmitted?.some((o) => o.id === 'redis-limits')).toBe(true);
  });

  it('a working redis client produces redis ceilings and is closed once', async () => {
    const redisClose = vi.fn(async () => {});
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => okFakePgClient(), {
      createRedisClient: () => ({
        queryServerLimits: async () => ({
          maxmemoryBytes: 1_000_000,
          usedMemoryBytes: 500_000,
          maxclients: 100,
          connectedClients: 10,
        }),
        close: redisClose,
      }),
      redisTarget: REDIS_TARGET,
    });
    expect(report.ceilings?.some((c) => c.id === 'redis-memory')).toBe(true);
    expect(report.ceilings?.some((c) => c.id === 'redis-clients')).toBe(true);
    expect(redisClose).toHaveBeenCalledTimes(1);
  });

  it('a ceilings-computation throw does not discard already-gathered findings', async () => {
    // computeCeilings calls sources.connectionUsage() directly (it's a required
    // source, not `?.()`-guarded) — a fake whose queryConnectionUsage() throws
    // exercises the isolation guard around computeCeilings/rankWeakLink.
    const fake = {
      queryConnectionCount: async () => 1,
      queryConnectionUsage: async () => { throw new Error('unexpected pool error'); },
      queryTableStats: async () => [],
      queryStatementStats: async () => null,
      queryStatementAggregate: async () => null,
      close: async () => {},
    };
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => fake);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.ceilings).toBeUndefined();
    expect(report.ceilingsOmitted).toBeUndefined();
    expect(report.weakLink).toBeUndefined();
  });

  it('a rejecting pg close neither loses the report nor skips redis cleanup', async () => {
    const redisClose = vi.fn(async () => {});
    const pgClient = {
      ...okFakePgClient(),
      close: async () => { throw new Error('close failed'); },
    };
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => pgClient, {
      createRedisClient: () => ({
        queryServerLimits: async () => null,
        close: redisClose,
      }),
      redisTarget: REDIS_TARGET,
    });
    expect(report.verdict).toBeDefined();
    expect(redisClose).toHaveBeenCalledTimes(1);
  });
});
