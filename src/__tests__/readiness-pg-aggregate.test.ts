// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { PgSimulator } from '../agent/pg-replication/simulator.js';

describe('PgSimulator statement aggregate fixture', () => {
  it('defaults to null (extension absent)', async () => {
    expect(await new PgSimulator().queryStatementAggregate()).toBeNull();
  });
  it('returns configured aggregate', async () => {
    const sim = new PgSimulator();
    sim.setStatementAggregate({ meanMs: 42.5, calls: 90_000 });
    expect(await sim.queryStatementAggregate()).toEqual({ meanMs: 42.5, calls: 90_000 });
  });
});
