// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { PgSimulator } from '../agent/pg-replication/simulator.js';

describe('PgSimulator readiness stats fixtures', () => {
  it('returns configured table stats', async () => {
    const sim = new PgSimulator();
    sim.setTableStats([{ table: 'orders', rowEstimate: 500_000, seqScans: 9_000, idxScans: 40 }]);
    const rows = await sim.queryTableStats();
    expect(rows).toEqual([{ table: 'orders', rowEstimate: 500_000, seqScans: 9_000, idxScans: 40 }]);
  });

  it('statement stats default to null (extension absent)', async () => {
    const sim = new PgSimulator();
    expect(await sim.queryStatementStats()).toBeNull();
  });

  it('returns configured statement stats', async () => {
    const sim = new PgSimulator();
    sim.setStatementStats([{ query: 'SELECT * FROM orders', calls: 1200, meanMs: 640 }]);
    const rows = await sim.queryStatementStats();
    expect(rows?.[0]?.meanMs).toBe(640);
  });
});
