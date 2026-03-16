// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const flinkRecoveryManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'flink-recovery',
    version: '1.0.0',
    description:
      'Recovers Flink stream processing jobs from checkpoint failures, savepoint corruption, TaskManager loss, and backpressure cascades.',
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
    tags: ['flink', 'streaming', 'processing', 'stateful'],
    plugin: {
      id: 'flink.domain-pack',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'flink',
        versionConstraint: '>=1.16.0 <2.0.0',
        components: ['jobmanager', 'taskmanager', 'job'],
      },
    ],
    triggerConditions: [
      {
        type: 'alert',
        source: 'prometheus',
        matchLabels: { alertname: 'FlinkCheckpointFailure' },
      },
      {
        type: 'health_check',
        name: 'flink_job_status',
        status: 'degraded',
      },
      {
        type: 'manual',
        description: 'Operator-initiated Flink job recovery',
      },
    ],
    failureScenarios: [
      'checkpoint_failure_cascade',
      'savepoint_corruption',
      'task_manager_loss',
      'backpressure_cascade',
    ],
    executionContexts: [
      {
        name: 'flink_read',
        type: 'structured_command',
        privilege: 'read',
        target: 'flink',
        allowedOperations: ['job_status', 'checkpoint_history', 'task_managers', 'backpressure', 'exceptions'],
        capabilities: [],
      },
      {
        name: 'flink_admin',
        type: 'structured_command',
        privilege: 'admin',
        target: 'flink',
        allowedOperations: ['job_restart', 'savepoint_trigger', 'checkpoint_configure', 'taskmanager_release'],
        capabilities: [
          'stream.job.restart',
          'stream.savepoint.trigger',
          'stream.checkpoint.configure',
          'stream.taskmanager.release',
        ],
      },
    ],
    observabilityDependencies: {
      required: ['flink_job_status', 'flink_checkpoint_status'],
      optional: ['prometheus_metrics', 'flink_backpressure'],
    },
    riskProfile: {
      maxRiskLevel: 'elevated',
      dataLossPossible: false,
      serviceDisruptionPossible: true,
    },
    humanInteraction: {
      requiresApproval: true,
      minimumApprovalRole: 'on_call_engineer',
      escalationPath: ['on_call_engineer', 'data_engineering_lead'],
    },
  },
};
