// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const etcdRecoveryManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'etcd-recovery',
    version: '1.0.0',
    description:
      'Recovers etcd clusters from leader election loops, NOSPACE alarms, member failures, and disk latency degradation.',
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
    tags: ['etcd', 'consensus', 'kubernetes', 'stateful'],
    plugin: {
      id: 'etcd.domain-pack',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'etcd',
        versionConstraint: '>=3.4.0 <4.0.0',
        components: ['member', 'cluster'],
      },
    ],
    triggerConditions: [
      {
        type: 'alert',
        source: 'prometheus',
        matchLabels: { alertname: 'EtcdLeaderElectionLoop' },
      },
      {
        type: 'health_check',
        name: 'etcd_cluster_status',
        status: 'degraded',
      },
      {
        type: 'manual',
        description: 'Operator-initiated etcd cluster recovery',
      },
    ],
    failureScenarios: [
      'leader_election_loop',
      'member_thrashing',
      'snapshot_corruption',
      'disk_latency_degradation',
    ],
    executionContexts: [
      {
        name: 'etcd_read',
        type: 'structured_command',
        privilege: 'read',
        target: 'etcd',
        allowedOperations: ['endpoint_status', 'member_list', 'alarm_list', 'endpoint_health'],
        capabilities: [],
      },
      {
        name: 'etcd_admin',
        type: 'structured_command',
        privilege: 'admin',
        target: 'etcd',
        allowedOperations: ['member_remove', 'member_add', 'defrag', 'snapshot_restore', 'alarm_disarm'],
        capabilities: [
          'consensus.member.remove',
          'consensus.member.add',
          'consensus.defrag',
          'consensus.snapshot.restore',
          'consensus.alarm.disarm',
        ],
      },
    ],
    observabilityDependencies: {
      required: ['etcd_cluster_health', 'etcd_member_status'],
      optional: ['prometheus_metrics', 'etcd_disk_latency'],
    },
    riskProfile: {
      maxRiskLevel: 'high',
      dataLossPossible: true,
      serviceDisruptionPossible: true,
    },
    humanInteraction: {
      requiresApproval: true,
      minimumApprovalRole: 'on_call_engineer',
      escalationPath: ['on_call_engineer', 'platform_lead', 'engineering_director'],
    },
  },
};
