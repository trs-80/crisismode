// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createSimulatorRegistration } from '../../config/simulator-registration.js';
import { kafkaRecoveryManifest } from './manifest.js';

export const kafkaRecoveryRegistration = createSimulatorRegistration({
  kind: 'kafka',
  name: 'kafka-recovery',
  manifest: kafkaRecoveryManifest,
  loadAgent: async () => {
    const { KafkaRecoveryAgent } = await import('./agent.js');
    return KafkaRecoveryAgent as any;
  },
  loadSimulator: async () => {
    const { KafkaSimulator } = await import('./simulator.js');
    return KafkaSimulator as any;
  },
});
