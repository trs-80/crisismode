// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';
import {
  MANIFEST_API_VERSION,
  RECOVERY_AGENT_COMPATIBILITY_MODE,
  defaultManifestMetadata,
} from '../../framework/manifest-defaults.js';

export const llmProviderManifest: AgentManifest = {
  apiVersion: MANIFEST_API_VERSION,
  kind: 'AgentManifest',
  metadata: {
    name: 'llm-provider-diagnosis',
    version: '1.0.0',
    description:
      'Read-only health checks for the LLM provider layer an AI app depends on: API key presence and validity, quota and billing state, rate-limit headroom, configured-model availability, and provider incidents.',
    ...defaultManifestMetadata(),
    tags: ['llm', 'ai-provider', 'api-key', 'quota', 'rate-limit'],
    plugin: {
      id: 'llm-provider.diagnosis',
      kind: 'domain_pack',
      maturity: 'live_validated',
      compatibilityMode: RECOVERY_AGENT_COMPATIBILITY_MODE,
    },
  },
  spec: {
    targetSystems: [
      {
        technology: 'llm-provider',
        versionConstraint: '*',
        components: ['api-key', 'quota', 'rate-limit', 'model', 'provider-status'],
      },
    ],
    triggerConditions: [
      { type: 'health_check', name: 'llm_provider_status', status: 'degraded' },
      { type: 'manual', description: 'Operator-initiated LLM provider check' },
    ],
    failureScenarios: [
      'api_key_missing',
      'api_key_invalid',
      'quota_or_billing_exhausted',
      'rate_limit_headroom_low',
      'configured_model_unavailable',
      'provider_incident',
    ],
    executionContexts: [
      {
        name: 'llm_read',
        type: 'api_call',
        privilege: 'read',
        target: 'llm-provider',
        allowedOperations: ['llm_provider_check'],
        capabilities: ['llm.provider.key.verify', 'llm.provider.status.read'],
      },
    ],
    observabilityDependencies: {
      required: ['provider_api_reachability'],
      optional: ['provider_status_page', 'provider_ratelimit_headers'],
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
