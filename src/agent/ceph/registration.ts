// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createSimulatorRegistration } from '../../config/simulator-registration.js';
import { cephRecoveryManifest } from './manifest.js';

export const cephStorageRegistration = createSimulatorRegistration({
  kind: 'ceph',
  name: 'ceph-storage-recovery',
  manifest: cephRecoveryManifest,
  loadAgent: async () => {
    const { CephRecoveryAgent } = await import('./agent.js');
    return CephRecoveryAgent as never;
  },
  loadSimulator: async () => {
    const { CephSimulator } = await import('./simulator.js');
    return CephSimulator as never;
  },
});
