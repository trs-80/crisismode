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
