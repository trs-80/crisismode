// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';
import {
  MANIFEST_API_VERSION,
  RECOVERY_AGENT_COMPATIBILITY_MODE,
  defaultManifestMetadata,
} from '../../framework/manifest-defaults.js';

export const serviceStatusManifest: AgentManifest = {
  apiVersion: MANIFEST_API_VERSION,
  kind: 'AgentManifest',
  metadata: {
    name: 'service-status-diagnosis',
    version: '1.0.0',
    description:
      'Checks configured third-party dependencies (Stripe, GitHub, Vercel, ...) against two separate facts: ' +
      'what the provider itself reports on its status page, and whether this machine can reach it. The two ' +
      'are never conflated, so a status-page hiccup is never reported as an outage. Read-only: it reports and ' +
      'notifies, never mutates a provider.',
    ...defaultManifestMetadata(),
    tags: ['service-status', 'third-party', 'dependency', 'status-page'],
    plugin: {
      id: 'service-status.domain-pack',
      kind: 'domain_pack',
      maturity: 'simulator_only',
      compatibilityMode: RECOVERY_AGENT_COMPATIBILITY_MODE,
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'service-status',
        versionConstraint: '*',
        components: ['status-page', 'reachability'],
      },
    ],
    triggerConditions: [
      { type: 'health_check', name: 'service_status', status: 'degraded' },
      { type: 'manual', description: 'Operator-initiated third-party service check' },
    ],
    failureScenarios: [
      // The neutral no-actionable-finding scenario is a valid plan outcome, not a failure mode
      // — required so validatePlan accepts healthy-path plans.
      'no_finding',
      'dependency_incident',
      'dependency_degraded',
      'dependency_unreachable',
    ],
    executionContexts: [
      {
        name: 'service_status_read',
        type: 'api_call',
        privilege: 'read',
        target: 'service-status',
        allowedOperations: ['query_services'],
        capabilities: [],
      },
    ],
    observabilityDependencies: {
      required: ['service_status_page'],
      optional: ['service_reachability'],
    },
    riskProfile: {
      maxRiskLevel: 'routine',
      dataLossPossible: false,
      serviceDisruptionPossible: false,
    },
    humanInteraction: {
      requiresApproval: false,
      minimumApprovalRole: 'on_call_engineer',
      escalationPath: ['on_call_engineer', 'engineering_lead'],
    },
  },
};
