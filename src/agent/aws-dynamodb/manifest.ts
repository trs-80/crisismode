// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';
import {
  MANIFEST_API_VERSION,
  RECOVERY_AGENT_COMPATIBILITY_MODE,
  defaultManifestMetadata,
} from '../../framework/manifest-defaults.js';

export const awsDynamoDbRecoveryManifest: AgentManifest = {
  apiVersion: MANIFEST_API_VERSION,
  kind: 'AgentManifest',
  metadata: {
    name: 'aws-dynamodb-recovery',
    version: '1.0.0',
    description: 'Recovers AWS DynamoDB tables from backup misconfigurations including disabled point-in-time recovery (PITR).',
    ...defaultManifestMetadata(),
    tags: ['aws', 'dynamodb', 'backup', 'pitr', 'point-in-time-recovery'],
    plugin: {
      id: 'aws-dynamodb.domain-pack',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: RECOVERY_AGENT_COMPATIBILITY_MODE,
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'aws-dynamodb',
        versionConstraint: '*',
        components: ['table', 'continuous-backups'],
      },
    ],
    triggerConditions: [
      {
        type: 'alert',
        source: 'aws-config',
        matchLabels: { alertname: 'DynamoDBPITRDisabled' },
      },
      {
        type: 'health_check',
        name: 'dynamodb_backup_status',
        status: 'degraded',
      },
      {
        type: 'manual',
        description: 'Operator-initiated DynamoDB PITR recovery',
      },
    ],
    failureScenarios: ['pitr_disabled', 'backup_disabled'],
    executionContexts: [
      {
        name: 'dynamodb_read',
        type: 'structured_command',
        privilege: 'read',
        target: 'dynamodb',
        allowedOperations: ['DescribeContinuousBackups', 'DescribeTable'],
        capabilities: ['dynamodb.backup.read'],
      },
      {
        name: 'dynamodb_write',
        type: 'structured_command',
        privilege: 'write',
        target: 'dynamodb',
        allowedOperations: ['UpdateContinuousBackups'],
        capabilities: ['dynamodb.backup.write'],
      },
    ],
    observabilityDependencies: {
      required: ['dynamodb_continuous_backups'],
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
      escalationPath: ['on_call_engineer', 'engineering_lead'],
    },
  },
};
