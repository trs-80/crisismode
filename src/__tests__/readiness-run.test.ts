// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect, vi } from 'vitest';
import { runRules, connectAndRunReadiness, resolveReadinessTargets } from '../readiness/run.js';
import { buildReport } from '../readiness/report.js';
import { allRules } from '../readiness/rules/index.js';
import type { ReadinessRule, ReadinessSources, ReadinessContext, ReadinessFinding } from '../readiness/types.js';
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

  it('registry contains the eight rules', () => {
    expect(allRules.map((r) => r.id).sort()).toEqual([
      'connection-headroom', 'connection-limit-tier', 'ivfflat-lists-mismatch',
      'long-transactions', 'missing-index', 'serverless-pooling', 'slow-queries',
      'vector-index-missing',
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

  it('connectionUsage is queried once per run and shared by rules and ceilings', async () => {
    const usageSpy = vi.fn(async () => ({ max: 100, total: 10, byState: {}, idleInTransactionOldest: [] }));
    const fake = { ...okFakePgClient(), queryConnectionUsage: usageSpy };
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => fake);
    expect(report.ceilings?.some((c) => c.id === 'db-connections')).toBe(true);
    expect(usageSpy).toHaveBeenCalledTimes(1);
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

  it('connect-failure reason survives an AggregateError with an empty message', async () => {
    // node-postgres surfaces dual-stack localhost ECONNREFUSED as an
    // AggregateError whose own .message is '' — the finding's reason must
    // carry the underlying error, not an empty string (issue #77).
    const aggregate = new AggregateError(
      [new Error('connect ECONNREFUSED 127.0.0.1:5432'), new Error('connect ECONNREFUSED ::1:5432')],
      '',
    );
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => ({
      ...okFakePgClient(),
      queryConnectionCount: async () => {
        throw aggregate;
      },
    }));
    expect(report.verdict).toBe('unknown');
    expect(report.findings[0]?.reason).toContain('ECONNREFUSED');
  });

  it('connect-failure reason falls back to the error code when no message exists anywhere', async () => {
    const bare = new AggregateError([], '');
    (bare as { code?: string }).code = 'ECONNREFUSED';
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => ({
      ...okFakePgClient(),
      queryConnectionCount: async () => {
        throw bare;
      },
    }));
    expect(report.findings[0]?.reason).toBe('ECONNREFUSED');
  });
});

describe('resolveReadinessTargets', () => {
  const CONFIG_PG: TargetConfig = {
    name: 'config-postgres',
    kind: 'postgresql',
    primary: { host: 'config-db', port: 5433 },
  };
  const ENV_PG: TargetConfig = {
    name: 'env-database-url',
    kind: 'postgresql',
    primary: { host: 'env-db', port: 5432 },
  };
  const CONFIG_REDIS: TargetConfig = {
    name: 'config-redis',
    kind: 'redis',
    primary: { host: 'config-redis-host', port: 6380 },
  };

  function fileConfig(targets: TargetConfig[]) {
    return { config: { targets } as never, source: 'file' as const };
  }

  it('prefers config-file targets over discovered env-hint targets', () => {
    const { pgTarget, redisTarget } = resolveReadinessTargets(fileConfig([CONFIG_PG, CONFIG_REDIS]), [ENV_PG]);
    expect(pgTarget?.name).toBe('config-postgres');
    expect(redisTarget?.name).toBe('config-redis');
  });

  it('falls back to derived targets when the config has no matching kind', () => {
    const { pgTarget, redisTarget } = resolveReadinessTargets(fileConfig([CONFIG_REDIS]), [ENV_PG]);
    expect(pgTarget?.name).toBe('env-database-url');
    expect(redisTarget?.name).toBe('config-redis');
  });

  it('handles an absent config (no crisismode.yaml)', () => {
    const { pgTarget, redisTarget } = resolveReadinessTargets({ config: null, source: 'none' }, [ENV_PG]);
    expect(pgTarget?.name).toBe('env-database-url');
    expect(redisTarget).toBeUndefined();
  });

  it('a config target without primary does not shadow a usable derived target', () => {
    // TargetConfig.primary is optional — an entry can exist purely to pin an
    // agent. Without connection info it cannot serve readiness and must not
    // shadow a fully-specified derived target.
    const agentPinOnly: TargetConfig = { name: 'pin-only', kind: 'postgresql', agent: 'postgresql-replication-recovery' };
    const { pgTarget } = resolveReadinessTargets(fileConfig([agentPinOnly]), [ENV_PG]);
    expect(pgTarget?.name).toBe('env-database-url');
  });

  it('an env-fallback synthesized config never shadows env-hint targets', () => {
    // loadConfigWithDetection synthesizes a legacy localhost target
    // (default-postgres, crisismode/crisismode credentials) whenever no config
    // file exists — that is a fallback default, not user intent, and must not
    // shadow a real DATABASE_URL-derived target.
    const legacy: TargetConfig = {
      name: 'default-postgres',
      kind: 'postgresql',
      primary: { host: 'localhost', port: 5432 },
      credentials: { type: 'value', username: 'crisismode', password: 'crisismode' },
    };
    const { pgTarget } = resolveReadinessTargets({ config: { targets: [legacy] } as never, source: 'env-fallback' }, [ENV_PG]);
    expect(pgTarget?.name).toBe('env-database-url');
  });
});

describe('connectAndRunReadiness pgvector wiring', () => {
  const VECTOR_RULE_IDS = ['vector-index-missing', 'ivfflat-lists-mismatch'];
  const vectorFindings = (report: { findings: ReadinessFinding[] }) =>
    report.findings.filter((f) => VECTOR_RULE_IDS.includes(f.ruleId));

  it('produces zero vector output when the client cannot probe pgvector', async () => {
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => okFakePgClient());
    expect(vectorFindings(report)).toHaveLength(0);
  });

  it("produces zero vector output on a database without the extension ('absent')", async () => {
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => ({
      ...okFakePgClient(),
      getPgvectorInventory: async () => 'absent' as const,
    }));
    expect(vectorFindings(report)).toHaveLength(0);
  });

  it('reports both vector rules as unknown when the catalog read fails', async () => {
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => ({
      ...okFakePgClient(),
      getPgvectorInventory: async () => null,
    }));
    const findings = vectorFindings(report);
    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.status).toBe('unknown');
      expect(f.reason).toBe('could not read pgvector catalog (connection or permission issue)');
    }
    // Unknown never moves the score (honesty contract).
    expect(report.score).toBe(100);
  });

  it('flags a large unindexed vector table end to end', async () => {
    const report = await connectAndRunReadiness(PG_TARGET, ctx, () => ({
      ...okFakePgClient(),
      getPgvectorInventory: async () => ({
        extensionVersion: '0.7.0',
        tables: [{ schema: 'public', table: 'documents', column: 'embedding', rowEstimate: 100_000 }],
        indexes: [],
      }),
    }));
    const missing = report.findings.find((f) => f.ruleId === 'vector-index-missing');
    expect(missing?.status).toBe('at_risk');
    expect(report.verdict).toBe('at-risk');
  });

  it('probes the pgvector catalog exactly once per run', async () => {
    const probe = vi.fn(async () => 'absent' as const);
    await connectAndRunReadiness(PG_TARGET, ctx, () => ({
      ...okFakePgClient(),
      getPgvectorInventory: probe,
    }));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does not mutate the caller-supplied context', async () => {
    const callerCtx = { ...ctx };
    await connectAndRunReadiness(PG_TARGET, callerCtx, () => ({
      ...okFakePgClient(),
      getPgvectorInventory: async () => 'absent' as const,
    }));
    expect(callerCtx.pgvector).toBeUndefined();
  });
});
