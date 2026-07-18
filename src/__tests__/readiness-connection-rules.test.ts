// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { connectionHeadroomRule } from '../readiness/rules/connection-headroom.js';
import { connectionLimitTierRule } from '../readiness/rules/connection-limit-tier.js';
import { longTransactionsRule } from '../readiness/rules/long-transactions.js';
import type { ReadinessSources, ReadinessContext } from '../readiness/types.js';
import type { ConnectionUsage } from '../agent/pg-replication/backend.js';

const ctx: ReadinessContext = {
  stack: { services: [], appStack: { framework: null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: [] }, envHints: [], platform: { platform: null, detected: false, signals: [] }, aiProviders: [], derivedTargets: [], derivedNotes: {}, confidence: 0 },
  serverless: false,
};

const sources = (usage: ConnectionUsage | null): ReadinessSources => ({
  connectionUsage: async () => usage,
  tableStats: async () => null,
  statementStats: async () => null,
});

const usage = (over: Partial<ConnectionUsage>): ConnectionUsage => ({
  max: 100, total: 10, byState: {}, idleInTransactionOldest: [], ...over,
});

describe('connectionHeadroomRule', () => {
  it('ready below 60% usage, reports headroom', async () => {
    const f = await connectionHeadroomRule.evaluate(sources(usage({ total: 30 })), ctx);
    expect(f.status).toBe('ready');
    expect(f.headroom).toBeCloseTo(0.7);
  });
  it('at_risk at 60% usage', async () => {
    const f = await connectionHeadroomRule.evaluate(sources(usage({ total: 60 })), ctx);
    expect(f.status).toBe('at_risk');
  });
  it('blocking at 80% usage', async () => {
    const f = await connectionHeadroomRule.evaluate(sources(usage({ total: 85 })), ctx);
    expect(f.status).toBe('blocking');
  });
  it('blocking at exact 80% boundary (usage >= 0.8)', async () => {
    const f = await connectionHeadroomRule.evaluate(sources(usage({ total: 80 })), ctx);
    expect(f.status).toBe('blocking');
  });
  it('unknown with reason when usage unavailable', async () => {
    const f = await connectionHeadroomRule.evaluate(sources(null), ctx);
    expect(f.status).toBe('unknown');
    expect(f.reason).toBeTruthy();
  });
});

describe('connectionLimitTierRule', () => {
  it('warns on small max_connections (free-tier shaped)', async () => {
    const f = await connectionLimitTierRule.evaluate(sources(usage({ max: 20 })), ctx);
    expect(f.status).toBe('at_risk');
  });
  it('at_risk at exact 25 max_connections boundary (max_connections <= 25)', async () => {
    const f = await connectionLimitTierRule.evaluate(sources(usage({ max: 25 })), ctx);
    expect(f.status).toBe('at_risk');
  });
  it('ready on generous max_connections', async () => {
    const f = await connectionLimitTierRule.evaluate(sources(usage({ max: 200 })), ctx);
    expect(f.status).toBe('ready');
  });
});

describe('longTransactionsRule', () => {
  it('flags idle-in-transaction sessions older than 60s', async () => {
    const f = await longTransactionsRule.evaluate(
      sources(usage({ idleInTransactionOldest: [{ pid: 1, ageSeconds: 300 }] })), ctx);
    expect(f.status).toBe('at_risk');
    expect(f.evidence.join(' ')).toContain('300');
  });
  it('at_risk at exact 60s boundary (ageSeconds >= 60)', async () => {
    const f = await longTransactionsRule.evaluate(
      sources(usage({ idleInTransactionOldest: [{ pid: 1, ageSeconds: 60 }] })), ctx);
    expect(f.status).toBe('at_risk');
  });
  it('ready when none exceed the threshold', async () => {
    const f = await longTransactionsRule.evaluate(
      sources(usage({ idleInTransactionOldest: [{ pid: 1, ageSeconds: 5 }] })), ctx);
    expect(f.status).toBe('ready');
  });
});
