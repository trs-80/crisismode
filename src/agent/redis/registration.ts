// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { redisMemoryManifest } from './manifest.js';

export const redisMemoryRegistration: AgentRegistration = {
  kind: 'redis',
  name: 'redis-memory-recovery',
  manifest: redisMemoryManifest,

  async createAgent(target) {
    const { RedisMemoryAgent } = await import('./agent.js');

    const hasLiveTarget = target.primary.host !== 'simulator';

    if (hasLiveTarget) {
      const { RedisLiveClient } = await import('./live-client.js');
      const backend = new RedisLiveClient({
        host: target.primary.host,
        port: target.primary.port,
        password: target.credentials.password,
      });
      await backend.connect();
      const agent = new RedisMemoryAgent(backend);
      return { agent, backend, target };
    }

    const { RedisSimulator } = await import('./simulator.js');
    const backend = new RedisSimulator();
    const agent = new RedisMemoryAgent(backend);
    return { agent, backend, target };
  },
};
