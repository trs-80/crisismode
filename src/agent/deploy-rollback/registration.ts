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

    // Use the Vercel live client when credentials are available
    const token = process.env['VERCEL_TOKEN'];
    const projectId = process.env['VERCEL_PROJECT_ID'];

    if (token && projectId) {
      const { DeployLiveClient } = await import('./live-client.js');
      const backend = new DeployLiveClient({
        token,
        projectId,
        teamId: process.env['VERCEL_TEAM_ID'],
        healthEndpoints: process.env['VERCEL_HEALTH_ENDPOINTS']?.split(',').filter(Boolean),
      });
      const agent = new DeployRollbackAgent(backend);
      return { agent, backend, target };
    }

    // Fall back to simulator for demo mode
    const { DeploySimulator } = await import('./simulator.js');
    const backend = new DeploySimulator();
    const agent = new DeployRollbackAgent(backend);
    return { agent, backend, target };
  },
};
