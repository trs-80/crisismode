// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const awsRdsRecoveryManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'aws-rds-recovery',
    version: '1.0.0',
    description:
      'Recovers AWS RDS instances from backup misconfigurations including disabled automated backups and missing snapshots.',
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
    tags: ['aws', 'rds', 'backup', 'snapshot', 'retention'],
    plugin: {
      id: 'aws-rds.domain-pack',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'aws-rds',
        versionConstraint: '*',
        components: ['db-instance', 'automated-backups', 'snapshots'],
      },
    ],
    triggerConditions: [
      {
        type: 'alert',
        source: 'aws-config',
        matchLabels: { alertname: 'RDSBackupDisabled' },
      },
      {
        type: 'health_check',
        name: 'rds_backup_status',
        status: 'degraded',
      },
      {
        type: 'manual',
        description: 'Operator-initiated RDS backup configuration recovery',
      },
    ],
    failureScenarios: ['backup_disabled', 'retention_disabled', 'stale_snapshot', 'missing_backup'],
    executionContexts: [
      {
        name: 'rds_read',
        type: 'structured_command',
        privilege: 'read',
        target: 'rds',
        allowedOperations: ['DescribeDBInstances', 'DescribeDBSnapshots'],
        capabilities: ['rds.instance.read', 'rds.snapshot.read'],
      },
      {
        name: 'rds_write',
        type: 'structured_command',
        privilege: 'write',
        target: 'rds',
        allowedOperations: ['ModifyDBInstance', 'CreateDBSnapshot'],
        capabilities: ['rds.instance.modify', 'rds.snapshot.create'],
      },
    ],
    observabilityDependencies: {
      required: ['rds_instance_config', 'rds_snapshots'],
      optional: ['aws_config_rules', 'cloudwatch_metrics'],
    },
    riskProfile: {
      maxRiskLevel: 'elevated',
      dataLossPossible: false,
      serviceDisruptionPossible: false,
    },
    humanInteraction: {
      requiresApproval: true,
      minimumApprovalRole: 'on_call_engineer',
      escalationPath: ['on_call_engineer', 'engineering_lead', 'database_admin'],
    },
  },
};
