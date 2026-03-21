// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { diskManifest } from './manifest.js';

export const diskExhaustionRegistration: AgentRegistration = {
  kind: 'disk',
  name: 'disk-exhaustion-recovery',
  manifest: diskManifest,

  async createAgent(target) {
    const { DiskExhaustionAgent } = await import('./agent.js');

    const hasLiveTarget = target.primary.host !== 'simulator';

    if (hasLiveTarget) {
      try {
        const { DiskLiveClient } = await import('./live-client.js');

        // Parse mount points from config if provided, otherwise use defaults
        const mountPoints = target.primary.host !== 'default' && target.primary.host !== 'auto'
          ? target.primary.host.split(',').map((mp) => mp.trim())
          : undefined;

        const backend = new DiskLiveClient({ mountPoints });
        const agent = new DiskExhaustionAgent(backend);
        return { agent, backend, target };
      } catch {
        // Live client construction failed — fall back to simulator
      }
    }

    const { DiskSimulator } = await import('./simulator.js');
    const backend = new DiskSimulator();
    const agent = new DiskExhaustionAgent(backend);
    return { agent, backend, target };
  },
};
