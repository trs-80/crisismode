// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { pgReplicationManifest } from './manifest.js';

export const pgReplicationRegistration: AgentRegistration = {
  kind: 'postgresql',
  name: 'postgresql-replication-recovery',
  manifest: pgReplicationManifest,

  async createAgent(target) {
    const { PgLiveClient } = await import('./live-client.js');
    const { PgReplicationAgent } = await import('./agent.js');

    const primaryConfig = {
      host: target.primary.host,
      port: target.primary.port,
      user: target.credentials.username || 'crisismode',
      password: target.credentials.password || 'crisismode',
      database: target.primary.database || 'crisismode',
    };

    const replicaConfig = target.replicas.length > 0
      ? {
          host: target.replicas[0].host,
          port: target.replicas[0].port,
          user: target.credentials.username || 'crisismode',
          password: target.credentials.password || 'crisismode',
          database: target.replicas[0].database || primaryConfig.database,
        }
      : undefined;

    const backend = new PgLiveClient(primaryConfig, replicaConfig);
    const agent = new PgReplicationAgent(backend);
    return { agent, backend, target };
  },
};
