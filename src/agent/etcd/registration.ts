// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createSimulatorRegistration } from '../../config/simulator-registration.js';
import { etcdRecoveryManifest } from './manifest.js';

export const etcdRecoveryRegistration = createSimulatorRegistration({
  kind: 'etcd',
  name: 'etcd-recovery',
  manifest: etcdRecoveryManifest,
  loadAgent: async () => {
    const { EtcdRecoveryAgent } = await import('./agent.js');
    return EtcdRecoveryAgent as any;
  },
  loadSimulator: async () => {
    const { EtcdSimulator } = await import('./simulator.js');
    return EtcdSimulator as any;
  },
});
