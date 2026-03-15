// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { kafkaRecoveryManifest } from './manifest.js';

export const kafkaRecoveryRegistration: AgentRegistration = {
  kind: 'kafka',
  name: 'kafka-recovery',
  manifest: kafkaRecoveryManifest,

  async createAgent(target) {
    const { KafkaRecoveryAgent } = await import('./agent.js');
    const { KafkaSimulator } = await import('./simulator.js');

    // Kafka live client not yet implemented — use simulator for now
    const backend = new KafkaSimulator();
    const agent = new KafkaRecoveryAgent(backend);
    return { agent, backend, target };
  },
};
