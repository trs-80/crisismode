// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createSimulatorRegistration } from '../../config/simulator-registration.js';
import { deployRollbackManifest } from './manifest.js';

export const deployRollbackRegistration = createSimulatorRegistration({
  kind: 'application',
  name: 'deploy-rollback-recovery',
  manifest: deployRollbackManifest,
  loadAgent: async () => {
    const { DeployRollbackAgent } = await import('./agent.js');
    return DeployRollbackAgent as any;
  },
  loadSimulator: async () => {
    const { DeploySimulator } = await import('./simulator.js');
    return DeploySimulator as any;
  },
});
