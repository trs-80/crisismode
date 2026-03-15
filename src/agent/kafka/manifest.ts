// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const kafkaRecoveryManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'kafka-recovery',
    version: '1.0.0',
    description:
      'Recovers Kafka clusters from under-replicated partitions, leader imbalance, consumer lag cascades, and ISR shrink.',
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
    tags: ['kafka', 'broker', 'messaging', 'stateful'],
    plugin: {
      id: 'kafka.domain-pack',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'kafka',
        versionConstraint: '>=3.0.0 <4.0.0',
        components: ['broker', 'topic', 'consumer_group'],
      },
    ],
    triggerConditions: [
      {
        type: 'alert',
        source: 'prometheus',
        matchLabels: { alertname: 'KafkaUnderReplicatedPartitions' },
      },
      {
        type: 'health_check',
        name: 'kafka_cluster_status',
        status: 'degraded',
      },
      {
        type: 'manual',
        description: 'Operator-initiated Kafka cluster recovery',
      },
    ],
    failureScenarios: [
      'partition_leader_imbalance',
      'under_replicated_partitions',
      'consumer_lag_cascade',
      'isr_shrink',
    ],
    executionContexts: [
      {
        name: 'kafka_read',
        type: 'structured_command',
        privilege: 'read',
        target: 'kafka',
        allowedOperations: ['cluster_metadata', 'topic_partitions', 'consumer_groups', 'broker_configs'],
        capabilities: [],
      },
      {
        name: 'kafka_admin',
        type: 'structured_command',
        privilege: 'admin',
        target: 'kafka',
        allowedOperations: ['leader_elect', 'partition_reassign', 'config_set', 'consumer_group_reset'],
        capabilities: [
          'broker.partition.reassign',
          'broker.leader.elect',
          'broker.config.set',
          'consumer.group.reset',
        ],
      },
    ],
    observabilityDependencies: {
      required: ['kafka_cluster_metadata', 'kafka_partition_status'],
      optional: ['prometheus_metrics', 'kafka_consumer_lag'],
    },
    riskProfile: {
      maxRiskLevel: 'elevated',
      dataLossPossible: false,
      serviceDisruptionPossible: true,
    },
    humanInteraction: {
      requiresApproval: true,
      minimumApprovalRole: 'on_call_engineer',
      escalationPath: ['on_call_engineer', 'engineering_lead'],
    },
  },
};
