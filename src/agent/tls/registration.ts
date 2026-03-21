// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { tlsManifest } from './manifest.js';

export const tlsRecoveryRegistration: AgentRegistration = {
  kind: 'tls',
  name: 'tls-certificate-recovery',
  manifest: tlsManifest,

  async createAgent(target) {
    const { TlsCertificateAgent } = await import('./agent.js');

    const hasLiveTarget = target.primary.host !== 'simulator'
      && target.primary.host !== 'default'
      && target.primary.host !== '';

    if (hasLiveTarget) {
      try {
        const { TlsLiveClient } = await import('./live-client.js');

        const endpoints = [{ host: target.primary.host, port: target.primary.port || 443 }];

        const backend = new TlsLiveClient({
          endpoints,
          connectTimeoutMs: 5000,
        });
        const agent = new TlsCertificateAgent(backend);
        return { agent, backend, target };
      } catch {
        // Live client construction failed — fall back to simulator
      }
    }

    const { TlsSimulator } = await import('./simulator.js');
    const backend = new TlsSimulator();
    const agent = new TlsCertificateAgent(backend);
    return { agent, backend, target };
  },
};
