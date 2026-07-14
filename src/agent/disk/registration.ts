// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { diskManifest } from './manifest.js';

export const diskExhaustionRegistration = createLiveRegistration({
  kind: 'disk',
  name: 'disk-exhaustion-recovery',
  manifest: diskManifest,
  loadAgent: async () => {
    const { DiskExhaustionAgent } = await import('./agent.js');
    return DiskExhaustionAgent as never;
  },
  loadSimulator: async () => {
    const { DiskSimulator } = await import('./simulator.js');
    return DiskSimulator as never;
  },
  buildLiveBackend: async (target) => {
    const { DiskLiveClient } = await import('./live-client.js');

    // Parse mount points from config if provided, otherwise use defaults
    const mountPoints = target.primary.host !== 'default' && target.primary.host !== 'auto'
      ? target.primary.host.split(',').map((mp) => mp.trim())
      : undefined;

    return new DiskLiveClient({ mountPoints });
  },
});
