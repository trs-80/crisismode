// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { missingIndexRule } from '../readiness/rules/missing-index.js';
import { slowQueriesRule } from '../readiness/rules/slow-queries.js';
import type { ReadinessSources, ReadinessContext, TableStat, StatementStat } from '../readiness/types.js';

const ctx = { serverless: false, target: { host: 'db', port: 5432 } } as ReadinessContext;

const sources = (tables: TableStat[] | null, stmts: StatementStat[] | null): ReadinessSources => ({
  connectionUsage: async () => null,
  tableStats: async () => tables,
  statementStats: async () => stmts,
});

describe('missingIndexRule', () => {
  it('flags a large seq-scan-dominated table', async () => {
    const f = await missingIndexRule.evaluate(
      sources([{ table: 'orders', rowEstimate: 100_000, seqScans: 5_000, idxScans: 10 }], null), ctx);
    expect(f.status).toBe('at_risk');
    expect(f.evidence.join(' ')).toContain('orders');
  });
  it('ignores small tables (seq scans are fine there)', async () => {
    const f = await missingIndexRule.evaluate(
      sources([{ table: 'settings', rowEstimate: 50, seqScans: 9_999, idxScans: 0 }], null), ctx);
    expect(f.status).toBe('ready');
  });
  it('unknown when table stats unavailable', async () => {
    const f = await missingIndexRule.evaluate(sources(null, null), ctx);
    expect(f.status).toBe('unknown');
  });
});

describe('slowQueriesRule', () => {
  it('flags queries with high mean execution time', async () => {
    const f = await slowQueriesRule.evaluate(
      sources(null, [{ query: 'SELECT * FROM orders', calls: 900, meanMs: 800 }]), ctx);
    expect(f.status).toBe('at_risk');
  });
  it('unknown with enablement hint when pg_stat_statements is absent', async () => {
    const f = await slowQueriesRule.evaluate(sources(null, null), ctx);
    expect(f.status).toBe('unknown');
    expect(f.reason).toContain('pg_stat_statements');
  });
  it('ready when all tracked queries are fast', async () => {
    const f = await slowQueriesRule.evaluate(
      sources(null, [{ query: 'SELECT 1', calls: 10_000, meanMs: 2 }]), ctx);
    expect(f.status).toBe('ready');
  });
});
