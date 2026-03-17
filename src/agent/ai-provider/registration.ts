// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { aiProviderManifest } from './manifest.js';

export const aiProviderRegistration: AgentRegistration = {
  kind: 'ai-provider',
  name: 'ai-provider-failover-recovery',
  manifest: aiProviderManifest,

  async createAgent(target) {
    const { AiProviderFailoverAgent } = await import('./agent.js');
    const { AiProviderSimulator } = await import('./simulator.js');

    // AI provider live client not yet implemented — use simulator for now
    const backend = new AiProviderSimulator();
    const agent = new AiProviderFailoverAgent(backend);
    return { agent, backend, target };
  },
};
