// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect, vi } from 'vitest';
import { runRules, connectAndRunReadiness } from '../readiness/run.js';
import { allRules } from '../readiness/rules/index.js';
import type { ReadinessRule, ReadinessSources, ReadinessContext } from '../readiness/types.js';
import type { TargetConfig } from '../config/schema.js';

const ctx = { serverless: false, target: { host: 'db', port: 5432 } } as ReadinessContext;
const sources: ReadinessSources = {
  connectionUsage: async () => ({ max: 100, total: 10, byState: {}, idleInTransactionOldest: [] }),
  tableStats: async () => [],
  statementStats: async () => null,
};

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
      close: closeSpy,
    }));

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(report.verdict).toBe('unknown');
    expect(report.findings[0]?.reason).toContain('connection refused');
  });

  it('closes the pg client after a successful run', async () => {
    const closeSpy = vi.fn(async () => {});
    const target: TargetConfig = {
      name: 'reachable',
      kind: 'postgresql',
      primary: { host: 'db', port: 5432 },
    };

    await connectAndRunReadiness(target, ctx, () => ({
      queryConnectionCount: async () => 1,
      queryConnectionUsage: async () => ({ max: 100, total: 10, byState: {}, idleInTransactionOldest: [] }),
      queryTableStats: async () => [],
      queryStatementStats: async () => null,
      close: closeSpy,
    }));

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
