// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { deployRollbackManifest } from './manifest.js';

export const deployRollbackRegistration = createLiveRegistration({
  kind: 'application',
  name: 'deploy-rollback-recovery',
  manifest: deployRollbackManifest,
  loadAgent: async () => {
    const { DeployRollbackAgent } = await import('./agent.js');
    return DeployRollbackAgent as never;
  },
  loadSimulator: async () => {
    const { DeploySimulator } = await import('./simulator.js');
    return DeploySimulator as never;
  },
  buildLiveBackend: async () => {
    const token = process.env['VERCEL_TOKEN'];
    const projectId = process.env['VERCEL_PROJECT_ID'];
    if (!token || !projectId) {
      throw new Error(
        "deploy-rollback requires VERCEL_TOKEN and VERCEL_PROJECT_ID to reach the Vercel API. Set both, or use host: 'simulator' for demo mode.",
      );
    }

    const { DeployLiveClient } = await import('./live-client.js');
    return new DeployLiveClient({
      token,
      projectId,
      teamId: process.env['VERCEL_TEAM_ID'],
      healthEndpoints: process.env['VERCEL_HEALTH_ENDPOINTS']?.split(',').filter(Boolean),
    });
  },
});
