// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { redisMemoryRegistration } from '../agent/redis/registration.js';

describe('redisMemoryRegistration honest failure', () => {
  it('still uses the simulator for explicit simulator targets', async () => {
    const instance = await redisMemoryRegistration.createAgent({
      name: 'sim', kind: 'redis',
      primary: { host: 'simulator', port: 0 },
      replicas: [], credentials: {},
    });
    expect(instance.backend.constructor.name).toBe('RedisSimulator');
    await instance.backend.close();
  });

  it('rejects (never simulates) when redis is unreachable', async () => {
    await expect(
      redisMemoryRegistration.createAgent({
        name: 'down', kind: 'redis',
        primary: { host: '127.0.0.1', port: 1 },
        replicas: [], credentials: {},
      }),
    ).rejects.toThrow();
  }, 10_000);
});
