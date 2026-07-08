// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { QueueLiveClient } from '../agent/queue-backlog/live-client.js';
import { QueueBacklogAgent } from '../agent/queue-backlog/agent.js';
import type { QueueBackend } from '../agent/queue-backlog/backend.js';

/** Minimal fake of the RedisClient surface QueueLiveClient uses. */
function fakeRedis(keys: string[]): Record<string, unknown> {
  return {
    scan: async (_cursor: string, ..._args: unknown[]) => ['0', keys],
    llen: async () => 0,
    zcard: async () => 0,
    smembers: async () => [],
    hgetall: async () => ({}),
    get: async () => null,
    zrangebyscore: async () => [],
    zrange: async () => [],
    ping: async () => 'PONG',
    quit: async () => 'OK',
  };
}

function clientWith(keys: string[], queueNames: string[] = []): QueueLiveClient {
  const client = new QueueLiveClient({ redisUrl: 'redis://unused:6379', queueNames });
  (client as unknown as { redis: unknown }).redis = fakeRedis(keys);
  return client;
}

describe('QueueLiveClient queue discovery', () => {
  it('discovers queue names from bull:*:meta keys', async () => {
    const client = clientWith(['bull:emails:meta', 'bull:webhooks:meta', 'bull:emails:wait']);
    expect(await client.discoverQueueNames()).toEqual(['emails', 'webhooks']);
  });

  it('prefers explicitly configured queue names over discovery', async () => {
    const client = clientWith(['bull:other:meta'], ['emails']);
    expect(await client.discoverQueueNames()).toEqual(['emails']);
  });

  it('handles queue names containing colons', async () => {
    const client = clientWith(['bull:app:jobs:meta']);
    expect(await client.discoverQueueNames()).toEqual(['app:jobs']);
  });

  it('returns empty stats (not an error) when no queues exist', async () => {
    const client = clientWith([]);
    expect(await client.getQueueStats()).toEqual([]);
  });

  it('re-discovers after an empty result', async () => {
    const client = new QueueLiveClient({ redisUrl: 'redis://unused:6379', queueNames: [] });
    let call = 0;
    const redis = fakeRedis([]);
    (redis as unknown as { scan: (...args: unknown[]) => Promise<[string, string[]]> }).scan = async (
      ..._args: unknown[]
    ) => {
      call += 1;
      return call === 1 ? ['0', []] : ['0', ['bull:emails:meta']];
    };
    (client as unknown as { redis: unknown }).redis = redis;

    expect(await client.discoverQueueNames()).toEqual([]);
    expect(await client.discoverQueueNames()).toEqual(['emails']);
  });

  it('connect failures never expose credentials', async () => {
    const client = new QueueLiveClient({ redisUrl: 'redis://user:supersecret@localhost:59998', queueNames: [] });
    await client.connect().then(
      () => {
        throw new Error('should have failed');
      },
      (err) => {
        expect(String(err)).not.toContain('supersecret');
      },
    );
  }, 10_000);

  it('disposes the failed redis client after a rejected connect (no lingering handle)', async () => {
    const client = new QueueLiveClient({ redisUrl: 'redis://localhost:59998', queueNames: [] });
    await expect(client.connect()).rejects.toThrow();
    expect((client as unknown as { redis: unknown }).redis).toBeNull();
  }, 10_000);
});

describe('QueueBacklogAgent with zero queues', () => {
  it('reports honest unknown status instead of simulated health', async () => {
    const emptyBackend: QueueBackend = {
      getQueueStats: async () => [],
      getWorkerStatus: async () => [],
      getDeadLetterStats: async () => ({ depth: 0, oldestAge: 0, recentErrors: [] }),
      getProcessingRate: async () => ({ incomingRate: 0, processingRate: 0, backlogGrowthRate: 0, estimatedClearTime: 0 }),
      executeCommand: async () => null,
      evaluateCheck: async () => true,
      close: async () => {},
    };
    const agent = new QueueBacklogAgent(emptyBackend);
    const health = await agent.assessHealth({} as never);
    expect(health.status).toBe('unknown');
    expect(health.summary).toContain('No BullMQ queues found');
  });
});
