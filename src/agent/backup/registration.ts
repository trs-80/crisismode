// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import type { BackupProvider } from './backend.js';
import { backupManifest } from './manifest.js';

export const backupVerificationRegistration = createLiveRegistration({
  kind: 'backup',
  name: 'backup-verification',
  manifest: backupManifest,
  loadAgent: async () => {
    const { BackupVerificationAgent } = await import('./agent.js');
    return BackupVerificationAgent as never;
  },
  loadSimulator: async () => {
    const { BackupSimulator } = await import('./simulator.js');
    return BackupSimulator as never;
  },
  buildLiveBackend: async (target) => {
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
    return new BackupCompositeClient(providers);
  },
});
