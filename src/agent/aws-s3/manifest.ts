// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';
import {
  MANIFEST_API_VERSION,
  RECOVERY_AGENT_COMPATIBILITY_MODE,
  defaultManifestMetadata,
} from '../../framework/manifest-defaults.js';

export const awsS3RecoveryManifest: AgentManifest = {
  apiVersion: MANIFEST_API_VERSION,
  kind: 'AgentManifest',
  metadata: {
    name: 'aws-s3-recovery',
    version: '1.0.0',
    description:
      'Recovers AWS S3 buckets from backup misconfigurations including disabled versioning and missing lifecycle rules.',
    ...defaultManifestMetadata(),
    tags: ['aws', 's3', 'backup', 'versioning', 'lifecycle'],
    plugin: {
      id: 'aws-s3.domain-pack',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: RECOVERY_AGENT_COMPATIBILITY_MODE,
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'aws-s3',
        versionConstraint: '*',
        components: ['bucket', 'versioning', 'lifecycle'],
      },
    ],
    triggerConditions: [
      {
        type: 'alert',
        source: 'aws-config',
        matchLabels: { alertname: 'S3VersioningDisabled' },
      },
      {
        type: 'health_check',
        name: 's3_backup_status',
        status: 'degraded',
      },
      {
        type: 'manual',
        description: 'Operator-initiated S3 backup configuration recovery',
      },
    ],
    failureScenarios: [
      'versioning_disabled',
      'versioning_suspended',
      'missing_lifecycle',
      'backup_misconfigured',
    ],
    executionContexts: [
      {
        name: 's3_read',
        type: 'structured_command',
        privilege: 'read',
        target: 's3',
        allowedOperations: ['GetBucketVersioning', 'GetBucketLifecycleConfiguration', 'HeadBucket'],
        capabilities: ['s3.versioning.read', 's3.lifecycle.read'],
      },
      {
        name: 's3_write',
        type: 'structured_command',
        privilege: 'write',
        target: 's3',
        allowedOperations: ['PutBucketVersioning', 'PutBucketLifecycleConfiguration'],
        capabilities: ['s3.versioning.write', 's3.lifecycle.write'],
      },
    ],
    observabilityDependencies: {
      required: ['s3_bucket_versioning', 's3_lifecycle_configuration'],
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
