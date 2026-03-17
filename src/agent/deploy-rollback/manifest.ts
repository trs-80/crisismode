// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';

export const deployRollbackManifest: AgentManifest = {
  apiVersion: 'v0.2.1',
  kind: 'AgentManifest',
  metadata: {
    name: 'deploy-rollback-recovery',
    version: '1.0.0',
    description:
      'Recovers applications from bad deployments by rolling back to a known-good version and stabilizing traffic routing.',
    authors: ['SRE Team <sre@example.com>'],
    license: 'Apache-2.0',
    tags: ['deploy', 'rollback', 'traffic', 'application'],
    plugin: {
      id: 'deploy.rollback',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: 'recovery_agent',
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'application',
        versionConstraint: '*',
        components: ['deployment', 'traffic-router', 'health-endpoint'],
      },
    ],
    triggerConditions: [
      {
        type: 'alert',
        source: 'prometheus',
        matchLabels: { alertname: 'error_rate_spike' },
      },
      {
        type: 'health_check',
        name: 'deploy_health',
        status: 'degraded',
      },
      {
        type: 'manual',
        description: 'Operator-initiated deploy rollback and traffic stabilization',
      },
    ],
    failureScenarios: [
      'bad_deploy_high_error_rate',
      'deploy_timeout_cascade',
      'canary_failure',
      'rollback_needed',
    ],
    executionContexts: [
      {
        name: 'deploy_read',
        type: 'api_call',
        privilege: 'read',
        target: 'application',
        allowedOperations: ['deploy_status', 'deploy_history', 'health_check'],
        capabilities: ['deploy.status.read', 'deploy.history.read'],
      },
      {
        name: 'deploy_write',
        type: 'api_call',
        privilege: 'write',
        target: 'application',
        allowedOperations: ['traffic_shift', 'full_rollback', 'deploy_status'],
        capabilities: ['deploy.rollback', 'traffic.shift', 'deploy.status.read'],
      },
    ],
    observabilityDependencies: {
      required: ['deploy_status', 'endpoint_health'],
      optional: ['prometheus_metrics', 'traffic_distribution'],
    },
    riskProfile: {
      maxRiskLevel: 'elevated',
      dataLossPossible: false,
      serviceDisruptionPossible: true,
    },
    humanInteraction: {
      requiresApproval: true,
      minimumApprovalRole: 'deploy_owner',
      escalationPath: ['on_call_engineer', 'deploy_owner', 'engineering_lead'],
    },
  },
};
