// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors
import { describe, it, expect } from 'vitest';
import { RedisSimulator } from '../agent/redis/simulator.js';

describe('RedisSimulator server-limits fixture', () => {
  it('defaults to null', async () => {
    expect(await new RedisSimulator().queryServerLimits()).toBeNull();
  });
  it('returns configured limits', async () => {
    const sim = new RedisSimulator();
    sim.setServerLimits({ maxmemoryBytes: 104_857_600, usedMemoryBytes: 52_428_800, maxclients: 10_000, connectedClients: 12 });
    const l = await sim.queryServerLimits();
    expect(l?.maxclients).toBe(10_000);
  });
});
