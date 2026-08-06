// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Stable check ids for the llm-provider agent.
 *
 * These are a published contract, not an implementation detail: the guidance
 * registry keys operator advice on them, and machine-mode scan output carries
 * them. Renaming one silently drops the guidance attached to it.
 *
 * Kept in a dependency-free module so consumers can import the ids without
 * importing the agent. Re-exported from backend.ts for in-agent use.
 */

export const LLM_PROVIDER_CHECK_IDS = {
  keyPresent: 'llm-provider.key_present',
  keyValid: 'llm-provider.key_valid',
  quotaBilling: 'llm-provider.quota_billing',
  rateLimitHeadroom: 'llm-provider.rate_limit_headroom',
  modelDeprecated: 'llm-provider.model_deprecated',
  providerStatus: 'llm-provider.provider_status',
} as const;

export type LlmProviderCheckId = (typeof LLM_PROVIDER_CHECK_IDS)[keyof typeof LLM_PROVIDER_CHECK_IDS];
