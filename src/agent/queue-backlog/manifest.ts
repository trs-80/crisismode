// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const queueBacklogManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'queue-backlog-recovery',
    version: '1.0.0',
    description:
      'Recovers message queue systems from backlog overflow, stuck workers, and dead letter queue floods.',
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
    tags: ['queue', 'worker', 'backlog', 'jobs'],
    plugin: {
      id: 'queue.backlog',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'message-queue',
        versionConstraint: '>=1.0.0',
        components: ['queue', 'workers', 'dead-letter-queue'],
      },
    ],
    triggerConditions: [
      {
        type: 'alert',
        source: 'prometheus',
        matchLabels: { alertname: 'QueueBacklogOverflow' },
      },
      {
        type: 'health_check',
        name: 'queue_backlog_status',
        status: 'degraded',
      },
      {
        type: 'manual',
        description: 'Operator-initiated queue backlog recovery',
      },
    ],
    failureScenarios: [
      'backlog_overflow',
      'stuck_workers',
      'dead_letter_flood',
      'processing_rate_collapse',
    ],
    executionContexts: [
      {
        name: 'queue_read',
        type: 'api_call',
        privilege: 'read',
        target: 'message-queue',
        allowedOperations: ['queue_stats', 'worker_status', 'dlq_stats', 'processing_rate'],
        capabilities: [
          'queue.stats.read',
          'queue.workers.read',
        ],
      },
      {
        name: 'queue_write',
        type: 'api_call',
        privilege: 'write',
        target: 'message-queue',
        allowedOperations: ['pause_intake', 'restart_workers', 'dlq_retry', 'scale_workers', 'resume_intake'],
        capabilities: [
          'queue.pause',
          'queue.workers.restart',
          'queue.dlq.retry',
          'queue.workers.scale',
        ],
      },
    ],
    observabilityDependencies: {
      required: ['queue_depth_metrics', 'worker_heartbeat'],
      optional: ['dlq_metrics', 'prometheus_metrics'],
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
