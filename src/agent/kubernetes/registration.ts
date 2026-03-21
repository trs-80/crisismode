// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { k8sRecoveryManifest } from './manifest.js';

export const k8sRecoveryRegistration: AgentRegistration = {
  kind: 'kubernetes',
  name: 'kubernetes-recovery',
  manifest: k8sRecoveryManifest,

  async createAgent(target) {
    const { K8sRecoveryAgent } = await import('./agent.js');

    const hasLiveTarget = target.primary.host !== 'simulator';

    if (hasLiveTarget) {
      try {
        const { K8sLiveClient } = await import('./live-client.js');
        const backend = new K8sLiveClient({
          kubeconfig: target.primary.host !== 'default' ? target.primary.host : undefined,
          context: target.primary.database || undefined,
          inCluster: target.primary.host === 'in-cluster',
          connectTimeoutMs: 2000,
        });
        await backend.connect();
        const agent = new K8sRecoveryAgent(backend);
        return { agent, backend, target };
      } catch {
        // Connection failed — fall back to simulator (e.g. in tests, dry-run with no cluster)
      }
    }

    const { K8sSimulator } = await import('./simulator.js');
    const backend = new K8sSimulator();
    const agent = new K8sRecoveryAgent(backend);
    return { agent, backend, target };
  },
};
