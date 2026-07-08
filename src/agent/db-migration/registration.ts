// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { dbMigrationManifest } from './manifest.js';

export const dbMigrationRegistration = createLiveRegistration({
  kind: 'managed-database',
  name: 'db-migration-recovery',
  manifest: dbMigrationManifest,
  loadAgent: async () => {
    const { DbMigrationAgent } = await import('./agent.js');
    return DbMigrationAgent as never;
  },
  loadSimulator: async () => {
    const { DbMigrationSimulator } = await import('./simulator.js');
    return DbMigrationSimulator as never;
  },
  buildLiveBackend: async (target) => {
    const { DbMigrationLiveClient } = await import('./live-client.js');
    const client = new DbMigrationLiveClient({
      host: target.primary.host,
      port: target.primary.port,
      user: target.credentials.username ?? 'postgres',
      password: target.credentials.password ?? '',
      database: target.primary.database ?? 'postgres',
    });
    await client.ping();
    return client;
  },
});
