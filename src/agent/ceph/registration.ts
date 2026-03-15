// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { cephRecoveryManifest } from './manifest.js';

export const cephStorageRegistration: AgentRegistration = {
  kind: 'ceph',
  name: 'ceph-storage-recovery',
  manifest: cephRecoveryManifest,

  async createAgent(target) {
    const { CephRecoveryAgent } = await import('./agent.js');
    const { CephSimulator } = await import('./simulator.js');

    // Ceph live client not yet implemented — use simulator for now
    const backend = new CephSimulator();
    const agent = new CephRecoveryAgent(backend);
    return { agent, backend, target };
  },
};
