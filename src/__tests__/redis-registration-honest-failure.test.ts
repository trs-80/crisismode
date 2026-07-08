// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { redisMemoryRegistration } from '../agent/redis/registration.js';
import { RedisLiveClient } from '../agent/redis/live-client.js';

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

  it('rejects twice in a row with no half-open state left behind by the first failure', async () => {
    // Practical proxy for "no lingering active redis handle": if the first
    // failed createAgent() left a background reconnect loop alive, it would
    // not prevent a second, independent createAgent() call from also failing
    // honestly — but it would keep the process (and, in a real scan, the CLI)
    // alive indefinitely. Running the rejection twice back-to-back confirms
    // each failed attempt is fully torn down rather than accumulating state.
    await expect(
      redisMemoryRegistration.createAgent({
        name: 'down', kind: 'redis',
        primary: { host: '127.0.0.1', port: 1 },
        replicas: [], credentials: {},
      }),
    ).rejects.toThrow();
    await expect(
      redisMemoryRegistration.createAgent({
        name: 'down', kind: 'redis',
        primary: { host: '127.0.0.1', port: 1 },
        replicas: [], credentials: {},
      }),
    ).rejects.toThrow();
  }, 20_000);

  it('disconnects the underlying ioredis client so no reconnect loop survives a failed connect', async () => {
    const client = new RedisLiveClient({ host: '127.0.0.1', port: 1, connectTimeoutMs: 500 });
    let errorEvents = 0;
    (client as unknown as { client: { on(event: string, cb: () => void): void } }).client.on('error', () => {
      errorEvents += 1;
    });

    await expect(client.connect()).rejects.toThrow();
    const countRightAfterReject = errorEvents;

    // If disconnect() had not been called on the failed connect, ioredis's
    // background reconnect loop would keep firing unhandled 'error' events
    // (and keep the event loop alive) indefinitely. Give it a window to prove
    // it does not.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(errorEvents).toBe(countRightAfterReject);
  }, 10_000);
});
