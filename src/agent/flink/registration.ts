// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createSimulatorRegistration } from '../../config/simulator-registration.js';
import { flinkRecoveryManifest } from './manifest.js';

export const flinkRecoveryRegistration = createSimulatorRegistration({
  kind: 'flink',
  name: 'flink-recovery',
  manifest: flinkRecoveryManifest,
  loadAgent: async () => {
    const { FlinkRecoveryAgent } = await import('./agent.js');
    return FlinkRecoveryAgent as never;
  },
  loadSimulator: async () => {
    const { FlinkSimulator } = await import('./simulator.js');
    return FlinkSimulator as never;
  },
});
