// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { configDriftManifest } from './manifest.js';

export const configDriftRegistration: AgentRegistration = {
  kind: 'application-config',
  name: 'config-drift-recovery',
  manifest: configDriftManifest,

  async createAgent(target) {
    const { ConfigDriftAgent } = await import('./agent.js');
    const { ConfigDriftSimulator } = await import('./simulator.js');

    // Config drift live client not yet implemented — use simulator for now
    const backend = new ConfigDriftSimulator();
    const agent = new ConfigDriftAgent(backend);
    return { agent, backend, target };
  },
};
