// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Static probe table for known AI providers: health endpoint, auth shape,
 * and the env var carrying the API key. Source of truth for both live
 * probing (registration) and autodiscovery detection (AI_ENV_VARS).
 *
 * SECURITY: API keys are read from env at backend-creation time and passed
 * directly to the live client. Never logged.
 */

import type { ProviderEndpointConfig } from './live-client.js';

export interface ProviderProbeSpec {
  provider: string;
  envVar: string;
  endpoint: string;
  healthPath: string;
  authHeader?: string;
  authPrefix?: string;
  extraHeaders?: Record<string, string>;
}

export const PROVIDER_PROBE_TABLE: ProviderProbeSpec[] = [
  { provider: 'openai', envVar: 'OPENAI_API_KEY', endpoint: 'https://api.openai.com/v1', healthPath: '/models' },
  {
    provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY',
    endpoint: 'https://api.anthropic.com/v1', healthPath: '/models',
    authHeader: 'x-api-key', authPrefix: '',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
  },
  { provider: 'cohere', envVar: 'COHERE_API_KEY', endpoint: 'https://api.cohere.com/v1', healthPath: '/models' },
  {
    provider: 'google', envVar: 'GOOGLE_AI_API_KEY',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta', healthPath: '/models',
    authHeader: 'x-goog-api-key', authPrefix: '',
  },
  { provider: 'mistral', envVar: 'MISTRAL_API_KEY', endpoint: 'https://api.mistral.ai/v1', healthPath: '/models' },
  { provider: 'replicate', envVar: 'REPLICATE_API_TOKEN', endpoint: 'https://api.replicate.com/v1', healthPath: '/models' },
  { provider: 'huggingface', envVar: 'HUGGINGFACE_API_KEY', endpoint: 'https://huggingface.co', healthPath: '/api/whoami-v2' },
];

/** Env-var detection list, derived from the probe table (single source of truth). */
export const AI_ENV_VARS: Array<{ envVar: string; provider: string }> =
  PROVIDER_PROBE_TABLE.map(({ envVar, provider }) => ({ envVar, provider }));

/**
 * Build live-client provider configs for every provider whose API key is
 * present in the given environment. Priority = table order.
 */
export function buildProviderConfigs(env: NodeJS.ProcessEnv): ProviderEndpointConfig[] {
  const configs: ProviderEndpointConfig[] = [];
  for (const spec of PROVIDER_PROBE_TABLE) {
    const apiKey = env[spec.envVar];
    if (!apiKey) continue;
    configs.push({
      name: spec.provider,
      endpoint: spec.endpoint,
      healthPath: spec.healthPath,
      apiKey,
      authHeader: spec.authHeader,
      authPrefix: spec.authPrefix,
      extraHeaders: spec.extraHeaders,
      priority: configs.length + 1,
      enabled: true,
    });
  }
  return configs;
}
