// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { dnsManifest } from './manifest.js';

export const dnsRecoveryRegistration = createLiveRegistration({
  kind: 'dns',
  name: 'dns-recovery',
  manifest: dnsManifest,
  loadAgent: async () => {
    const { DnsRecoveryAgent } = await import('./agent.js');
    return DnsRecoveryAgent as never;
  },
  loadSimulator: async () => {
    const { DnsSimulator } = await import('./simulator.js');
    return DnsSimulator as never;
  },
  buildLiveBackend: async (target) => {
    const { DnsLiveClient } = await import('./live-client.js');
    return new DnsLiveClient({
      resolvers: target.primary.host !== 'auto' && target.primary.host !== 'default'
        ? [target.primary.host]
        : undefined,
      queryTimeoutMs: 3000,
    });
  },
});
