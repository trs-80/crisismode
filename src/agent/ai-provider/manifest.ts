// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const aiProviderManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'ai-provider-failover-recovery',
    version: '1.0.0',
    description:
      'Recovers from AI provider degradation by detecting latency spikes, timeout storms, and rate limiting, then orchestrating circuit breaker trips and fallback chain activation.',
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
    tags: ['ai-provider', 'failover', 'circuit-breaker', 'latency'],
    plugin: {
      id: 'ai-provider.failover',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'ai-provider',
        versionConstraint: '*',
        components: ['provider-endpoint', 'circuit-breaker', 'fallback-chain'],
      },
    ],
    triggerConditions: [
      {
        type: 'alert',
        source: 'prometheus',
        matchLabels: { alertname: 'AiProviderLatencyCritical' },
      },
      {
        type: 'health_check',
        name: 'ai_provider_status',
        status: 'degraded',
      },
      {
        type: 'manual',
        description: 'Operator-initiated AI provider failover recovery',
      },
    ],
    failureScenarios: [
      'provider_timeout_storm',
      'provider_degraded_latency',
      'provider_complete_outage',
      'rate_limit_exceeded',
    ],
    executionContexts: [
      {
        name: 'provider_read',
        type: 'api_call',
        privilege: 'read',
        target: 'ai-provider',
        allowedOperations: ['provider_health_check', 'verify_routing'],
        capabilities: ['provider.status.read', 'provider.metrics.read'],
      },
      {
        name: 'provider_write',
        type: 'api_call',
        privilege: 'write',
        target: 'ai-provider',
        allowedOperations: ['trip_circuit_breaker', 'activate_fallback_chain', 'restore_primary'],
        capabilities: ['provider.circuit_breaker.trip', 'provider.fallback.activate', 'provider.traffic.shift'],
      },
    ],
    observabilityDependencies: {
      required: ['provider_health_status', 'request_metrics'],
      optional: ['circuit_breaker_state', 'prometheus_metrics'],
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
