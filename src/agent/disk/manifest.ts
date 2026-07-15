// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';
import {
  MANIFEST_API_VERSION,
  RECOVERY_AGENT_COMPATIBILITY_MODE,
  defaultManifestMetadata,
} from '../../framework/manifest-defaults.js';

export const diskManifest: AgentManifest = {
  apiVersion: MANIFEST_API_VERSION,
  kind: 'AgentManifest',
  metadata: {
    name: 'disk-exhaustion-recovery',
    version: '1.0.0',
    description:
      'Detects and alerts on local disk exhaustion including filesystem full, inode exhaustion, log directory bloat, and boot partition issues.',
    ...defaultManifestMetadata(),
    tags: ['disk', 'storage', 'filesystem', 'inode', 'log-rotation'],
    plugin: {
      id: 'disk.exhaustion',
      kind: 'domain_pack',
      maturity: 'live_validated',
      compatibilityMode: RECOVERY_AGENT_COMPATIBILITY_MODE,
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'disk',
        versionConstraint: '*',
        components: ['filesystem', 'inode-table', 'log-directory', 'boot-partition'],
      },
    ],
    triggerConditions: [
      { type: 'alert', source: 'prometheus', matchLabels: { alertname: 'DiskSpaceCritical' } },
      { type: 'alert', source: 'prometheus', matchLabels: { alertname: 'InodeExhaustion' } },
      { type: 'health_check', name: 'disk_usage_status', status: 'degraded' },
      { type: 'manual', description: 'Operator-initiated disk usage inspection' },
    ],
    failureScenarios: [
      'disk_full',
      'disk_nearly_full',
      'inode_exhaustion',
      'log_directory_bloat',
      'boot_partition_full',
    ],
    executionContexts: [
      {
        name: 'disk_read',
        type: 'api_call',
        privilege: 'read',
        target: 'local-filesystem',
        allowedOperations: ['check_disk_usage', 'find_large_entries', 'check_log_rotation'],
        capabilities: ['disk.usage.read', 'disk.files.inspect', 'disk.logs.inspect'],
      },
    ],
    observabilityDependencies: {
      required: ['filesystem_usage'],
      optional: ['inode_usage', 'log_rotation_status'],
    },
    riskProfile: {
      maxRiskLevel: 'routine',
      dataLossPossible: false,
      serviceDisruptionPossible: false,
    },
    humanInteraction: {
      requiresApproval: false,
      minimumApprovalRole: 'on_call_engineer',
      escalationPath: ['on_call_engineer', 'system_administrator', 'engineering_lead'],
    },
  },
};
