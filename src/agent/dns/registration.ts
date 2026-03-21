// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { dnsManifest } from './manifest.js';

export const dnsRecoveryRegistration: AgentRegistration = {
  kind: 'dns',
  name: 'dns-recovery',
  manifest: dnsManifest,

  async createAgent(target) {
    const { DnsRecoveryAgent } = await import('./agent.js');

    const hasLiveTarget = target.primary.host !== 'simulator';

    if (hasLiveTarget) {
      try {
        const { DnsLiveClient } = await import('./live-client.js');
        const backend = new DnsLiveClient({
          resolvers: target.primary.host !== 'auto' && target.primary.host !== 'default'
            ? [target.primary.host]
            : undefined,
          queryTimeoutMs: 3000,
        });
        const agent = new DnsRecoveryAgent(backend);
        return { agent, backend, target };
      } catch {
        // Live client construction failed — fall back to simulator
      }
    }

    const { DnsSimulator } = await import('./simulator.js');
    const backend = new DnsSimulator();
    const agent = new DnsRecoveryAgent(backend);
    return { agent, backend, target };
  },
};
