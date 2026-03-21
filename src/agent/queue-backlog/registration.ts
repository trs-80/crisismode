// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createSimulatorRegistration } from '../../config/simulator-registration.js';
import { queueBacklogManifest } from './manifest.js';

export const queueBacklogRegistration = createSimulatorRegistration({
  kind: 'message-queue',
  name: 'queue-backlog-recovery',
  manifest: queueBacklogManifest,
  loadAgent: async () => {
    const { QueueBacklogAgent } = await import('./agent.js');
    return QueueBacklogAgent as any;
  },
  loadSimulator: async () => {
    const { QueueSimulator } = await import('./simulator.js');
    return QueueSimulator as any;
  },
});
