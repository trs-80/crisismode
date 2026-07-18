// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { serverlessPoolingRule } from '../readiness/rules/serverless-pooling.js';
import type { ReadinessSources, ReadinessContext } from '../readiness/types.js';

const sources = (max: number | null): ReadinessSources => ({
  connectionUsage: async () => (max === null ? null : { max, total: 1, byState: {}, idleInTransactionOldest: [] }),
  tableStats: async () => null,
  statementStats: async () => null,
});

const ctx = (serverless: boolean, port: number): ReadinessContext =>
  ({ serverless, target: { host: 'db.example.com', port } }) as ReadinessContext;

describe('serverlessPoolingRule', () => {
  it('not applicable without serverless signals', () => {
    expect(serverlessPoolingRule.applicable(ctx(false, 5432))).toBe(false);
  });
  it('blocking: serverless + direct port + small limit', async () => {
    const f = await serverlessPoolingRule.evaluate(sources(20), ctx(true, 5432));
    expect(f.status).toBe('blocking');
    expect(f.explanation).toContain('heuristic');
  });
  it('ready when using a pooled port', async () => {
    const f = await serverlessPoolingRule.evaluate(sources(20), ctx(true, 6543));
    expect(f.status).toBe('ready');
  });
  it('at_risk (not blocking) when direct port but generous limit', async () => {
    const f = await serverlessPoolingRule.evaluate(sources(500), ctx(true, 5432));
    expect(f.status).toBe('at_risk');
  });
  it('unknown when max_connections unreadable', async () => {
    const f = await serverlessPoolingRule.evaluate(sources(null), ctx(true, 5432));
    expect(f.status).toBe('unknown');
  });
  it('boundary: exactly 25 connections is blocking', async () => {
    const f = await serverlessPoolingRule.evaluate(sources(25), ctx(true, 5432));
    expect(f.status).toBe('blocking');
  });
  it('boundary: 26 connections is at_risk (not blocking)', async () => {
    const f = await serverlessPoolingRule.evaluate(sources(26), ctx(true, 5432));
    expect(f.status).toBe('at_risk');
  });
});
