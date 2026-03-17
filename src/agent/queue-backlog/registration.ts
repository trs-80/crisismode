// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { queueBacklogManifest } from './manifest.js';

export const queueBacklogRegistration: AgentRegistration = {
  kind: 'message-queue',
  name: 'queue-backlog-recovery',
  manifest: queueBacklogManifest,

  async createAgent(target) {
    const { QueueBacklogAgent } = await import('./agent.js');
    const { QueueSimulator } = await import('./simulator.js');

    // Queue live client not yet implemented — use simulator for now
    const backend = new QueueSimulator();
    const agent = new QueueBacklogAgent(backend);
    return { agent, backend, target };
  },
};
