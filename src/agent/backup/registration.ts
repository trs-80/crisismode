// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import type { BackupProvider } from './backend.js';
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
        const providers: BackupProvider[] = [];

        // Always include filesystem provider
        const { BackupLiveClient } = await import('./live-client.js');
        const locations = target.primary.host !== 'default' && target.primary.host !== 'auto'
          ? target.primary.host.split(',').map((loc) => loc.trim())
          : ['/var/backups'];
        const liveClient = new BackupLiveClient({ locations });
        providers.push(liveClient.asProvider());

        // Try AWS RDS provider (graceful if SDK not installed)
        try {
          const { RdsSnapshotProvider } = await import('./aws-rds-provider.js');
          providers.push(new RdsSnapshotProvider());
        } catch {
          // @aws-sdk/client-rds not installed — skip
        }

        // Try AWS S3 provider (graceful if SDK not installed)
        try {
          const { S3BackupProvider } = await import('./aws-s3-provider.js');
          providers.push(new S3BackupProvider());
        } catch {
          // @aws-sdk/client-s3 not installed — skip
        }

        const { BackupCompositeClient } = await import('./composite-client.js');
        const backend = new BackupCompositeClient(providers);
        const agent = new BackupVerificationAgent(backend);
        return { agent, backend, target };
      } catch {
        // Composite client construction failed — fall back to simulator
      }
    }

    const { BackupSimulator } = await import('./simulator.js');
    const backend = new BackupSimulator();
    const agent = new BackupVerificationAgent(backend);
    return { agent, backend, target };
  },
};
