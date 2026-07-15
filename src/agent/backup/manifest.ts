// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';
import {
  MANIFEST_API_VERSION,
  RECOVERY_AGENT_COMPATIBILITY_MODE,
  defaultManifestMetadata,
} from '../../framework/manifest-defaults.js';

export const backupManifest: AgentManifest = {
  apiVersion: MANIFEST_API_VERSION,
  kind: 'AgentManifest',
  metadata: {
    name: 'backup-verification',
    version: '1.0.0',
    description:
      'Verifies backup existence, recency, integrity, and coverage across configured backup providers. Surfaces RPO/RTO risks before disaster strikes.',
    ...defaultManifestMetadata(),
    tags: ['backup', 'disaster-recovery', 'rpo', 'rto', 'verification', 'data-protection'],
    plugin: {
      id: 'backup.verification',
      kind: 'domain_pack',
      maturity: 'live_validated',
      compatibilityMode: RECOVERY_AGENT_COMPATIBILITY_MODE,
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'backup',
        versionConstraint: '*',
        components: ['file-directory', 'pg-dump', 'pg-basebackup', 'zfs-snapshot', 'lvm-snapshot', 'aws-rds-snapshot', 'aws-s3-backup'],
      },
    ],
    triggerConditions: [
      { type: 'alert', source: 'prometheus', matchLabels: { alertname: 'BackupStale' } },
      { type: 'alert', source: 'prometheus', matchLabels: { alertname: 'BackupFailed' } },
      { type: 'alert', source: 'cloudwatch', matchLabels: { alertname: 'RDSSnapshotFailed' } },
      { type: 'health_check', name: 'backup_verification_status', status: 'degraded' },
      { type: 'manual', description: 'Operator-initiated backup verification' },
    ],
    failureScenarios: [
      'no_backups_found',
      'stale_backup',
      'size_anomaly',
      'integrity_failure',
      'incomplete_coverage',
      'rto_at_risk',
      'rds_snapshot_error',
      'glacier_restore_delay',
      's3_versioning_disabled',
    ],
    executionContexts: [
      {
        name: 'backup_read',
        type: 'api_call',
        privilege: 'read',
        target: 'backup-storage',
        allowedOperations: ['verify_backups', 'list_providers', 'inventory_backups', 'check_integrity'],
        capabilities: ['backup.inventory.list', 'backup.verify.integrity', 'backup.rpo.evaluate', 'backup.schedule.check', 'backup.aws.rds.describe', 'backup.aws.s3.list', 'backup.aws.sts.verify'],
      },
    ],
    observabilityDependencies: {
      required: ['backup_location'],
      optional: ['backup_schedule', 'rpo_target', 'rto_target'],
    },
    riskProfile: {
      maxRiskLevel: 'routine',
      dataLossPossible: false,
      serviceDisruptionPossible: false,
    },
    humanInteraction: {
      requiresApproval: false,
      minimumApprovalRole: 'on_call_engineer',
      escalationPath: ['on_call_engineer', 'database_administrator', 'engineering_lead'],
    },
  },
};
