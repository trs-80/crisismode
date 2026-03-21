// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const k8sRecoveryManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'kubernetes-recovery',
    version: '1.0.0',
    description:
      'Recovers Kubernetes clusters from node failures, pod crash loops, stuck deployments, and PVC termination issues.',
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
    tags: ['kubernetes', 'k8s', 'orchestration', 'stateful'],
    plugin: {
      id: 'kubernetes.domain-pack',
      kind: 'domain_pack',
      maturity: 'live_validated',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'kubernetes',
        versionConstraint: '>=1.27.0 <1.33.0',
        components: ['node', 'pod', 'deployment', 'pvc'],
      },
    ],
    triggerConditions: [
      {
        type: 'alert',
        source: 'prometheus',
        matchLabels: { alertname: 'KubernetesNodeNotReady' },
      },
      {
        type: 'health_check',
        name: 'k8s_cluster_status',
        status: 'degraded',
      },
      {
        type: 'manual',
        description: 'Operator-initiated Kubernetes cluster recovery',
      },
    ],
    failureScenarios: [
      'reconciliation_loop_stuck',
      'node_not_ready_cascade',
      'pod_crashloop_cascade',
      'pvc_stuck_terminating',
    ],
    executionContexts: [
      {
        name: 'k8s_read',
        type: 'structured_command',
        privilege: 'read',
        target: 'kubernetes',
        allowedOperations: ['node_status', 'pod_list', 'events', 'deployment_status', 'pvc_status'],
        capabilities: [],
      },
      {
        name: 'k8s_admin',
        type: 'structured_command',
        privilege: 'admin',
        target: 'kubernetes',
        allowedOperations: ['node_cordon', 'node_drain', 'pod_delete', 'deployment_restart', 'pvc_finalize'],
        capabilities: [
          'k8s.node.cordon',
          'k8s.node.drain',
          'k8s.pod.delete',
          'k8s.deployment.restart',
          'k8s.pvc.finalize',
        ],
      },
    ],
    observabilityDependencies: {
      required: ['k8s_node_status', 'k8s_pod_status'],
      optional: ['prometheus_metrics', 'k8s_events'],
    },
    riskProfile: {
      maxRiskLevel: 'high',
      dataLossPossible: false,
      serviceDisruptionPossible: true,
    },
    humanInteraction: {
      requiresApproval: true,
      minimumApprovalRole: 'on_call_engineer',
      escalationPath: ['on_call_engineer', 'platform_lead', 'engineering_director'],
    },
  },
};
