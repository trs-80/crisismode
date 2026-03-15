// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const pgReplicationManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'postgresql-replication-recovery',
    version: '1.2.0',
    description:
      'Recovers PostgreSQL streaming replication failures including lag cascades, slot overflow, and replica divergence.',
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
    tags: ['postgresql', 'replication', 'database', 'stateful'],
    plugin: {
      id: 'postgresql.domain-pack',
      kind: 'domain_pack',
      maturity: 'live_validated',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'postgresql',
        versionConstraint: '>=14.0 <18.0',
        components: ['primary', 'replica', 'replication-slot'],
      },
    ],
    triggerConditions: [
      {
        type: 'alert',
        source: 'prometheus',
        matchLabels: { alertname: 'PostgresReplicationLagCritical' },
      },
      {
        type: 'health_check',
        name: 'pg_replication_status',
        status: 'degraded',
      },
      {
        type: 'manual',
        description: 'Operator-initiated replication recovery',
      },
    ],
    failureScenarios: [
      'replication_lag_cascade',
      'replication_slot_overflow',
      'replica_divergence',
      'wal_sender_timeout',
    ],
    executionContexts: [
      {
        name: 'postgresql_read',
        type: 'sql',
        privilege: 'read',
        target: 'postgresql',
        capabilities: ['db.query.read'],
      },
      {
        name: 'postgresql_write',
        type: 'sql',
        privilege: 'write',
        target: 'postgresql',
        capabilities: [
          'db.query.read',
          'db.query.write',
          'db.replica.disconnect',
          'db.replica.reseed',
          'db.replication_slot.drop',
          'db.replication_slot.create',
        ],
      },
      {
        name: 'linux_process',
        type: 'structured_command',
        privilege: 'process_management',
        target: 'linux',
        allowedOperations: ['service_restart', 'process_signal', 'config_reload'],
        capabilities: ['traffic.backend.detach', 'traffic.backend.attach'],
      },
    ],
    observabilityDependencies: {
      required: ['pg_stat_replication', 'pg_replication_slots'],
      optional: ['prometheus_metrics', 'pg_stat_wal_receiver'],
    },
    riskProfile: {
      maxRiskLevel: 'high',
      dataLossPossible: true,
      serviceDisruptionPossible: true,
    },
    humanInteraction: {
      requiresApproval: true,
      minimumApprovalRole: 'database_owner',
      escalationPath: ['on_call_dba', 'database_owner', 'engineering_lead'],
    },
  },
};
