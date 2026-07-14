// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { k8sRecoveryManifest } from './manifest.js';

export const k8sRecoveryRegistration = createLiveRegistration({
  kind: 'kubernetes',
  name: 'kubernetes-recovery',
  manifest: k8sRecoveryManifest,
  loadAgent: async () => {
    const { K8sRecoveryAgent } = await import('./agent.js');
    return K8sRecoveryAgent as never;
  },
  loadSimulator: async () => {
    const { K8sSimulator } = await import('./simulator.js');
    return K8sSimulator as never;
  },
  buildLiveBackend: async (target) => {
    const { K8sLiveClient } = await import('./live-client.js');
    const backend = new K8sLiveClient({
      kubeconfig: target.primary.host !== 'default' ? target.primary.host : undefined,
      context: target.primary.database || undefined,
      inCluster: target.primary.host === 'in-cluster',
      connectTimeoutMs: 2000,
    });
    await backend.connect();
    return backend;
  },
});
