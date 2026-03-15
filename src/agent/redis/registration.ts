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
    const { RedisSimulator } = await import('./simulator.js');

    // Redis live client not yet implemented — use simulator for now
    const backend = new RedisSimulator();
    const agent = new RedisMemoryAgent(backend);
    return { agent, backend, target };
  },
};
