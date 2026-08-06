// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentManifest } from '../../types/manifest.js';
import {
  MANIFEST_API_VERSION,
  RECOVERY_AGENT_COMPATIBILITY_MODE,
  defaultManifestMetadata,
} from '../../framework/manifest-defaults.js';
import type { LlmProviderId } from './provider-table.js';
import { LLM_PROVIDERS } from './provider-table.js';

/**
 * Maturity per provider. Anthropic and OpenAI have been validated against real
 * keys; Google and OpenRouter are simulator_only until live validation is added.
 */
function getMaturityForProvider(provider: LlmProviderId): 'live_validated' | 'simulator_only' {
  switch (provider) {
    case 'anthropic':
    case 'openai':
      return 'live_validated';
    case 'google':
    case 'openrouter':
      return 'simulator_only';
  }
}

/**
 * Build a manifest for a single LLM provider. Each provider gets its own
 * registration with a provider-scoped kind (llm-provider.anthropic, etc.)
 * so maturity can be honest per provider.
 */
export function buildLlmProviderManifest(provider: LlmProviderId): AgentManifest {
  return {
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
        id: `llm-provider.${provider}`,
        kind: 'domain_pack',
        maturity: getMaturityForProvider(provider),
        compatibilityMode: RECOVERY_AGENT_COMPATIBILITY_MODE,
      },
    },
    spec: {
      targetSystems: [
        {
          technology: `llm-provider.${provider}`,
          versionConstraint: '*',
          components: ['api-key', 'quota', 'rate-limit', 'model', 'provider-status'],
        },
      ],
      triggerConditions: [
        { type: 'health_check', name: 'llm_provider_status', status: 'degraded' },
        { type: 'manual', description: 'Operator-initiated LLM provider check' },
      ],
      failureScenarios: [
        // The neutral no-actionable-finding scenario is a valid plan outcome, not a failure mode
        // — required so validatePlan accepts healthy-path plans.
        'no_finding',
        'api_key_missing',
        'api_key_invalid',
        'key_scope_limited',
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
          target: `llm-provider.${provider}`,
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
}

export const llmProviderManifests: Record<LlmProviderId, AgentManifest> = Object.fromEntries(
  LLM_PROVIDERS.map((spec) => [spec.id, buildLlmProviderManifest(spec.id)]),
) as Record<LlmProviderId, AgentManifest>;

/**
 * Same per-provider maturity as each manifest's `metadata.plugin.maturity`,
 * exposed directly so the live client's `listCapabilityProviders()` (Task 7)
 * can look it up without importing a whole manifest to read one field.
 */
export const LLM_PROVIDER_MATURITY: Record<LlmProviderId, 'live_validated' | 'simulator_only'> =
  Object.fromEntries(LLM_PROVIDERS.map((spec) => [spec.id, getMaturityForProvider(spec.id)])) as Record<
    LlmProviderId,
    'live_validated' | 'simulator_only'
  >;
