// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const backupManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'backup-verification',
    version: '1.0.0',
    description:
      'Verifies backup existence, recency, integrity, and coverage across configured backup providers. Surfaces RPO/RTO risks before disaster strikes.',
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
    tags: ['backup', 'disaster-recovery', 'rpo', 'rto', 'verification', 'data-protection'],
    plugin: {
      id: 'backup.verification',
      kind: 'domain_pack',
      maturity: 'live_validated',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'backup',
        versionConstraint: '*',
        components: ['file-directory', 'pg-dump', 'pg-basebackup', 'zfs-snapshot', 'lvm-snapshot'],
      },
    ],
    triggerConditions: [
      { type: 'alert', source: 'prometheus', matchLabels: { alertname: 'BackupStale' } },
      { type: 'alert', source: 'prometheus', matchLabels: { alertname: 'BackupFailed' } },
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
    ],
    executionContexts: [
      {
        name: 'backup_read',
        type: 'api_call',
        privilege: 'read',
        target: 'backup-storage',
        allowedOperations: ['verify_backups', 'list_providers', 'inventory_backups', 'check_integrity'],
        capabilities: ['backup.inventory.list', 'backup.verify.integrity', 'backup.rpo.evaluate', 'backup.schedule.check'],
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
