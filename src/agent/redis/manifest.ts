// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';
import {
  MANIFEST_API_VERSION,
  RECOVERY_AGENT_COMPATIBILITY_MODE,
  defaultManifestMetadata,
} from '../../framework/manifest-defaults.js';

export const redisMemoryManifest: AgentManifest = {
  apiVersion: MANIFEST_API_VERSION,
  kind: 'AgentManifest',
  metadata: {
    name: 'redis-memory-recovery',
    version: '1.0.0',
    description:
      'Recovers Redis instances from memory pressure, eviction storms, and client connection exhaustion.',
    ...defaultManifestMetadata(),
    tags: ['redis', 'memory', 'cache', 'stateful'],
    plugin: {
      id: 'redis.domain-pack',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: RECOVERY_AGENT_COMPATIBILITY_MODE,
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'redis',
        versionConstraint: '>=6.0.0 <8.0.0',
        components: ['primary', 'replica'],
      },
    ],
    triggerConditions: [
      {
        type: 'alert',
        source: 'prometheus',
        matchLabels: { alertname: 'RedisMemoryPressureCritical' },
      },
      {
        type: 'health_check',
        name: 'redis_memory_status',
        status: 'degraded',
      },
      {
        type: 'manual',
        description: 'Operator-initiated Redis memory recovery',
      },
    ],
    failureScenarios: [
      'memory_pressure',
      'client_exhaustion',
      'slow_query_storm',
    ],
    executionContexts: [
      {
        name: 'redis_admin',
        type: 'redis_command',
        privilege: 'admin',
        target: 'redis',
        allowedOperations: ['CONFIG', 'CLIENT', 'MEMORY', 'SLOWLOG', 'INFO', 'SCAN'],
        capabilities: [
          'cache.client.disconnect',
          'cache.expiry.trigger',
          'cache.config.set',
        ],
      },
    ],
    observabilityDependencies: {
      required: ['redis_info_memory', 'redis_info_clients'],
      optional: ['redis_slowlog', 'prometheus_metrics'],
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
