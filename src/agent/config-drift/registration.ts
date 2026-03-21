// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createSimulatorRegistration } from '../../config/simulator-registration.js';
import { configDriftManifest } from './manifest.js';

export const configDriftRegistration = createSimulatorRegistration({
  kind: 'application-config',
  name: 'config-drift-recovery',
  manifest: configDriftManifest,
  loadAgent: async () => {
    const { ConfigDriftAgent } = await import('./agent.js');
    return ConfigDriftAgent as any;
  },
  loadSimulator: async () => {
    const { ConfigDriftSimulator } = await import('./simulator.js');
    return ConfigDriftSimulator as any;
  },
});
