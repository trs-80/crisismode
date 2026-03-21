// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createSimulatorRegistration } from '../../config/simulator-registration.js';
import { dbMigrationManifest } from './manifest.js';

export const dbMigrationRegistration = createSimulatorRegistration({
  kind: 'managed-database',
  name: 'db-migration-recovery',
  manifest: dbMigrationManifest,
  loadAgent: async () => {
    const { DbMigrationAgent } = await import('./agent.js');
    return DbMigrationAgent as any;
  },
  loadSimulator: async () => {
    const { DbMigrationSimulator } = await import('./simulator.js');
    return DbMigrationSimulator as any;
  },
});
