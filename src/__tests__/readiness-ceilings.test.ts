// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { computeCeilings } from '../readiness/ceilings.js';
import type { ReadinessSources, ReadinessContext } from '../readiness/types.js';

const ctx = (over: Partial<{ serverless: boolean; framework: string | null }> = {}): ReadinessContext =>
  ({
    serverless: over.serverless ?? false,
    target: { host: 'db', port: 5432 },
    stack: {
      services: [], envHints: [], aiProviders: [], derivedTargets: [], derivedNotes: {}, confidence: 0,
      platform: { platform: null, detected: false, signals: [] },
      appStack: { framework: over.framework ?? null, language: null, hasDockerfile: false, hasCIConfig: false, dependencies: [] },
    },
  }) as ReadinessContext;

const sources = (over: Partial<ReadinessSources> = {}): ReadinessSources => ({
  connectionUsage: async () => ({ max: 100, total: 10, byState: {}, idleInTransactionOldest: [] }),
  tableStats: async () => null,
  statementStats: async () => null,
  ...over,
});

describe('computeCeilings', () => {
  it('db-connections ceiling from max_connections (declared)', async () => {
    const { ceilings } = await computeCeilings(sources(), ctx());
    const c = ceilings.find((x) => x.id === 'db-connections');
    expect(c?.value).toBe(100);
    expect(c?.unit).toBe('connections');
    expect(c?.evidenceClasses).toEqual(['declared']);
    expect(c?.evidence.join(' ')).toContain('max_connections = 100');
    expect(c?.caveat).toContain('at most');
  });

  it('db-throughput via Little: 100 conns / 50ms = 2000 q/s (declared+measured)', async () => {
    const { ceilings } = await computeCeilings(
      sources({ statementAggregate: async () => ({ meanMs: 50, calls: 10_000 }) }), ctx());
    const c = ceilings.find((x) => x.id === 'db-throughput');
    expect(c?.value).toBe(2000);
    expect(c?.unit).toBe('queries/s');
    expect(c?.evidenceClasses).toEqual(['declared', 'measured']);
  });

  it('db-throughput omitted with reason when aggregate unavailable', async () => {
    const { ceilings, omitted } = await computeCeilings(sources(), ctx());
    expect(ceilings.some((x) => x.id === 'db-throughput')).toBe(false);
    expect(omitted.find((o) => o.id === 'db-throughput')?.reason).toContain('pg_stat_statements');
  });

  it('db-throughput omitted with reason when meanMs is zero', async () => {
    const { ceilings, omitted } = await computeCeilings(
      sources({ statementAggregate: async () => ({ meanMs: 0, calls: 5 }) }), ctx());
    expect(ceilings.some((x) => x.id === 'db-throughput')).toBe(false);
    expect(omitted.find((o) => o.id === 'db-throughput')?.reason).toContain('pg_stat_statements');
  });

  it('redis ceilings from limits probe', async () => {
    const { ceilings } = await computeCeilings(
      sources({ redisLimits: async () => ({ maxmemoryBytes: 1024, usedMemoryBytes: 512, maxclients: 10000, connectedClients: 5 }) }), ctx());
    expect(ceilings.find((x) => x.id === 'redis-memory')?.value).toBe(1024);
    expect(ceilings.find((x) => x.id === 'redis-clients')?.value).toBe(10000);
  });

  it('redis maxmemory=0 (unlimited) omits redis-memory ceiling but keeps redis-clients', async () => {
    const { ceilings, omitted } = await computeCeilings(
      sources({ redisLimits: async () => ({ maxmemoryBytes: 0, usedMemoryBytes: 512, maxclients: 10000, connectedClients: 5 }) }), ctx());
    expect(ceilings.some((x) => x.id === 'redis-memory')).toBe(false);
    expect(omitted.find((o) => o.id === 'redis-memory')?.reason).toContain('unlimited');
    expect(ceilings.find((x) => x.id === 'redis-clients')?.value).toBe(10000);
  });

  it('redis maxmemory=1 (just above zero) reports the redis-memory ceiling', async () => {
    const { ceilings, omitted } = await computeCeilings(
      sources({ redisLimits: async () => ({ maxmemoryBytes: 1, usedMemoryBytes: 0, maxclients: 10000, connectedClients: 5 }) }), ctx());
    expect(ceilings.find((x) => x.id === 'redis-memory')?.value).toBe(1);
    expect(omitted.some((o) => o.id === 'redis-memory')).toBe(false);
  });

  it('fd-limit reported for non-serverless, suppressed for serverless', async () => {
    const withFd = sources({ fdLimit: async () => 1024 });
    const local = await computeCeilings(withFd, ctx({ serverless: false }));
    expect(local.ceilings.find((x) => x.id === 'fd-limit')?.value).toBe(1024);
    const sls = await computeCeilings(withFd, ctx({ serverless: true }));
    expect(sls.ceilings.some((x) => x.id === 'fd-limit')).toBe(false);
    expect(sls.omitted.find((o) => o.id === 'fd-limit')?.reason).toContain('serverless');
  });

  it('network-egress from declared Mbps only', async () => {
    const { ceilings } = await computeCeilings(
      sources({ declaredEgressMbps: async () => 30 }), ctx());
    const c = ceilings.find((x) => x.id === 'network-egress');
    expect(c?.value).toBe(3_750_000); // 30 Mbps = 3.75 MB/s
    expect(c?.unit).toBe('bytes/s');
    expect(c?.evidenceClasses).toEqual(['declared']);
  });

  it('node-typical range appears only for Node frameworks and is typical-class', async () => {
    const { ceilings } = await computeCeilings(sources(), ctx({ framework: 'express' }));
    const c = ceilings.find((x) => x.id === 'node-typical');
    expect(c?.value).toBeNull();
    expect(c?.rangeLow).toBeGreaterThan(0);
    expect(c?.evidenceClasses).toEqual(['typical']);
    const none = await computeCeilings(sources(), ctx({ framework: null }));
    expect(none.ceilings.some((x) => x.id === 'node-typical')).toBe(false);
  });

  it('connectionUsage null omits both db ceilings with reasons', async () => {
    const { ceilings, omitted } = await computeCeilings(
      sources({ connectionUsage: async () => null }), ctx());
    expect(ceilings.filter((x) => x.id.startsWith('db-'))).toHaveLength(0);
    expect(omitted.map((o) => o.id)).toEqual(expect.arrayContaining(['db-connections', 'db-throughput']));
  });
});
