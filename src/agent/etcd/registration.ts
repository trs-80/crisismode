// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { etcdRecoveryManifest } from './manifest.js';

export const etcdRecoveryRegistration: AgentRegistration = {
  kind: 'etcd',
  name: 'etcd-recovery',
  manifest: etcdRecoveryManifest,

  async createAgent(target) {
    const { EtcdRecoveryAgent } = await import('./agent.js');
    const { EtcdSimulator } = await import('./simulator.js');

    // Etcd live client not yet implemented — use simulator for now
    const backend = new EtcdSimulator();
    const agent = new EtcdRecoveryAgent(backend);
    return { agent, backend, target };
  },
};
