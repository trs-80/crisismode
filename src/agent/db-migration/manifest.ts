// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const dbMigrationManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'db-migration-recovery',
    version: '1.0.0',
    description:
      'Recovers managed databases from broken migrations, connection pool exhaustion, and DB saturation caused by stuck DDL operations.',
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
    tags: ['database', 'migration', 'connections', 'saturation'],
    plugin: {
      id: 'db.migration',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'managed-database',
        versionConstraint: '>=14.0.0',
        components: ['connection-pool', 'migration-runner', 'query-engine'],
      },
    ],
    triggerConditions: [
      {
        type: 'alert',
        source: 'prometheus',
        matchLabels: { alertname: 'DatabaseMigrationStuck' },
      },
      {
        type: 'alert',
        source: 'prometheus',
        matchLabels: { alertname: 'ConnectionPoolExhausted' },
      },
      {
        type: 'health_check',
        name: 'db_migration_status',
        status: 'degraded',
      },
      {
        type: 'manual',
        description: 'Operator-initiated database migration recovery',
      },
    ],
    failureScenarios: [
      'migration_lock_timeout',
      'connection_pool_exhaustion',
      'migration_rollback_needed',
      'long_running_query_block',
    ],
    executionContexts: [
      {
        name: 'db_read',
        type: 'sql',
        privilege: 'read',
        target: 'managed-database',
        allowedOperations: ['SELECT', 'SHOW', 'EXPLAIN'],
        capabilities: [
          'db.query.read',
          'db.connections.read',
        ],
      },
      {
        name: 'db_write',
        type: 'sql',
        privilege: 'write',
        target: 'managed-database',
        allowedOperations: ['SELECT', 'SHOW', 'KILL', 'ALTER', 'DROP', 'ROLLBACK'],
        capabilities: [
          'db.query.read',
          'db.query.write',
          'db.connections.terminate',
          'db.migration.rollback',
        ],
      },
    ],
    observabilityDependencies: {
      required: ['pg_stat_activity', 'pg_locks', 'schema_migrations'],
      optional: ['prometheus_metrics', 'pg_stat_statements'],
    },
    riskProfile: {
      maxRiskLevel: 'high',
      dataLossPossible: true,
      serviceDisruptionPossible: true,
    },
    humanInteraction: {
      requiresApproval: true,
      minimumApprovalRole: 'on_call_engineer',
      escalationPath: ['on_call_engineer', 'engineering_lead', 'database_administrator'],
    },
  },
};
