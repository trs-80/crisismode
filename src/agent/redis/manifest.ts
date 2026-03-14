import type { AgentManifest } from '../../types/manifest.js';

export const redisMemoryManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'redis-memory-recovery',
    version: '1.0.0',
    description:
      'Recovers Redis instances from memory pressure, eviction storms, and client connection exhaustion.',
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
    tags: ['redis', 'memory', 'cache', 'stateful'],
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
