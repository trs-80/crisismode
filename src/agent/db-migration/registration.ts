// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { dbMigrationManifest } from './manifest.js';

export const dbMigrationRegistration: AgentRegistration = {
  kind: 'managed-database',
  name: 'db-migration-recovery',
  manifest: dbMigrationManifest,

  async createAgent(target) {
    const { DbMigrationAgent } = await import('./agent.js');
    const { DbMigrationSimulator } = await import('./simulator.js');

    // Live client not yet implemented — use simulator for now
    const backend = new DbMigrationSimulator();
    const agent = new DbMigrationAgent(backend);
    return { agent, backend, target };
  },
};
