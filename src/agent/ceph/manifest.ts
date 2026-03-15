// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const cephRecoveryManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'ceph-storage-recovery',
    version: '1.0.0',
    description:
      'Recovers Ceph storage clusters from OSD failures, degraded placement groups, slow OSD operations, and pool near-full conditions.',
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
    tags: ['ceph', 'storage', 'distributed', 'stateful'],
    plugin: {
      id: 'ceph.domain-pack',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'ceph',
        versionConstraint: '>=17.0.0 <20.0.0',
        components: ['osd', 'mon', 'pool', 'pg'],
      },
    ],
    triggerConditions: [
      {
        type: 'alert',
        source: 'prometheus',
        matchLabels: { alertname: 'CephOSDDown' },
      },
      {
        type: 'health_check',
        name: 'ceph_cluster_status',
        status: 'degraded',
      },
      {
        type: 'manual',
        description: 'Operator-initiated Ceph storage recovery',
      },
    ],
    failureScenarios: [
      'osd_down_cascade',
      'pg_degraded',
      'slow_osd_ops',
      'pool_nearfull',
    ],
    executionContexts: [
      {
        name: 'ceph_read',
        type: 'structured_command',
        privilege: 'read',
        target: 'ceph',
        allowedOperations: ['cluster_status', 'osd_tree', 'pg_status', 'pool_stats', 'health_detail'],
        capabilities: [],
      },
      {
        name: 'ceph_admin',
        type: 'structured_command',
        privilege: 'admin',
        target: 'ceph',
        allowedOperations: ['osd_reweight', 'osd_remove', 'pg_repair', 'pool_quota_set'],
        capabilities: ['storage.osd.reweight', 'storage.osd.remove', 'storage.pg.repair', 'storage.pool.quota.set'],
      },
    ],
    observabilityDependencies: {
      required: ['ceph_cluster_health', 'ceph_osd_status'],
      optional: ['prometheus_metrics', 'ceph_pg_stats'],
    },
    riskProfile: {
      maxRiskLevel: 'high',
      dataLossPossible: true,
      serviceDisruptionPossible: true,
    },
    humanInteraction: {
      requiresApproval: true,
      minimumApprovalRole: 'on_call_engineer',
      escalationPath: ['on_call_engineer', 'storage_lead', 'engineering_director'],
    },
  },
};
