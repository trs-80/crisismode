// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { deployRollbackManifest } from './manifest.js';

export const deployRollbackRegistration: AgentRegistration = {
  kind: 'application',
  name: 'deploy-rollback-recovery',
  manifest: deployRollbackManifest,

  async createAgent(target) {
    const { DeployRollbackAgent } = await import('./agent.js');
    const { DeploySimulator } = await import('./simulator.js');

    // Deploy live client not yet implemented — use simulator for now
    const backend = new DeploySimulator();
    const agent = new DeployRollbackAgent(backend);
    return { agent, backend, target };
  },
};
