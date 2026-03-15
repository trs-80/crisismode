// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { flinkRecoveryManifest } from './manifest.js';

export const flinkRecoveryRegistration: AgentRegistration = {
  kind: 'flink',
  name: 'flink-recovery',
  manifest: flinkRecoveryManifest,

  async createAgent(target) {
    const { FlinkRecoveryAgent } = await import('./agent.js');
    const { FlinkSimulator } = await import('./simulator.js');

    // Flink live client not yet implemented — use simulator for now
    const backend = new FlinkSimulator();
    const agent = new FlinkRecoveryAgent(backend);
    return { agent, backend, target };
  },
};
