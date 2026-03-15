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
    const { K8sSimulator } = await import('./simulator.js');

    // K8s live client not yet implemented — use simulator for now
    const backend = new K8sSimulator();
    const agent = new K8sRecoveryAgent(backend);
    return { agent, backend, target };
  },
};
