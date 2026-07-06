// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { redisMemoryManifest } from './manifest.js';

export const redisMemoryRegistration = createLiveRegistration({
  kind: 'redis',
  name: 'redis-memory-recovery',
  manifest: redisMemoryManifest,
  loadAgent: async () => {
    const { RedisMemoryAgent } = await import('./agent.js');
    return RedisMemoryAgent as never;
  },
  loadSimulator: async () => {
    const { RedisSimulator } = await import('./simulator.js');
    return RedisSimulator as never;
  },
  buildLiveBackend: async (target) => {
    const { RedisLiveClient } = await import('./live-client.js');
    const backend = new RedisLiveClient({
      host: target.primary.host,
      port: target.primary.port,
      password: target.credentials.password,
      connectTimeoutMs: 2000,
    });
    await backend.connect();
    return backend;
  },
});
