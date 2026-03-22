// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { backupManifest } from './manifest.js';

export const backupVerificationRegistration: AgentRegistration = {
  kind: 'backup',
  name: 'backup-verification',
  manifest: backupManifest,

  async createAgent(target) {
    const { BackupVerificationAgent } = await import('./agent.js');

    const hasLiveTarget = target.primary.host !== 'simulator';

    if (hasLiveTarget) {
      try {
        const { BackupLiveClient } = await import('./live-client.js');

        const locations = target.primary.host !== 'default' && target.primary.host !== 'auto'
          ? target.primary.host.split(',').map((loc) => loc.trim())
          : ['/var/backups'];

        const backend = new BackupLiveClient({ locations });
        const agent = new BackupVerificationAgent(backend);
        return { agent, backend, target };
      } catch {
        // Live client construction failed — fall back to simulator
      }
    }

    const { BackupSimulator } = await import('./simulator.js');
    const backend = new BackupSimulator();
    const agent = new BackupVerificationAgent(backend);
    return { agent, backend, target };
  },
};
