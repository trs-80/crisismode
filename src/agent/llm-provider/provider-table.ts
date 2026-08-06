// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Static provider table for the llm-provider agent, and the single source of
 * truth for AI provider environment variables across CrisisMode
 * (src/agent/ai-provider/provider-table.ts and src/cli/autodiscovery.ts both
 * import AI_ENV_VARS from here).
 *
 * SECURITY: this module reads key *names* from an environment object. It never
 * logs, stores, or returns key material. Output that needs to identify a key
 * uses `fingerprintKey`, which exposes the last four characters only.
 *
 * POLICY: process.env only. Nothing here reads .env files — parsing a secrets
 * file is deliberately out of scope (see the design doc's non-goals).
 */

export type LlmProviderId = 'anthropic' | 'openai' | 'google' | 'openrouter';

export interface LlmProviderSpec {
  /** Stable id used in target names, findings, and check output. */
  id: LlmProviderId;
  /** Human label for operator-facing text. */
  label: string;
  /** Env vars carrying the API key, highest priority first. */
  envVars: string[];
  /** Env vars that may name the model the app uses, highest priority first. */
  modelEnvVars: string[];
  /** Hostname of the API — used as the derived target's primary host. */
  apiHost: string;
  /** Free, read-only models-list endpoint. */
  modelsUrl: string;
  /** Authenticated key-info endpoint, when the provider has one. */
  keyInfoUrl?: string;
  /** Shape of the models-list response body. */
  modelsJsonShape: 'data_id' | 'models_name';
  /**
   * True when the provider's models-list endpoint pages results (a
   * `nextPageToken` field means more remain). Only Google does today —
   * OpenAI, Anthropic, and OpenRouter's `/models` all return a flat list in
   * one call, so `checkModel()` fetches exactly one page for them regardless
   * of this flag. See the design doc's "Model-list extraction, normalization,
   * and pagination" section.
   */
  paginated?: boolean;
  /** Header carrying the API key. */
  authHeader: string;
  /** Prefix for the auth header value ('' means the raw key). */
  authPrefix: string;
  /** Static headers the provider requires. */
  extraHeaders: Record<string, string>;
  /** Lowercase prefix of the provider's ratelimit response headers, if any. */
  rateLimitHeaderPrefix?: string;
  /** Status API endpoint, if the provider publishes one. */
  statusUrl?: string;
  /** Response shape of `statusUrl`. */
  statusFormat?: 'statuspage_v2' | 'google_cloud_incidents';
  /** Where an operator can read more when a check fails. */
  docsUrl: string;
}

export const LLM_PROVIDERS: LlmProviderSpec[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    envVars: ['ANTHROPIC_API_KEY'],
    modelEnvVars: ['ANTHROPIC_MODEL', 'CLAUDE_MODEL'],
    apiHost: 'api.anthropic.com',
    modelsUrl: 'https://api.anthropic.com/v1/models',
    modelsJsonShape: 'data_id',
    authHeader: 'x-api-key',
    authPrefix: '',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
    rateLimitHeaderPrefix: 'anthropic-ratelimit-',
    statusUrl: 'https://status.claude.com/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
    docsUrl: 'https://docs.claude.com/en/api/errors',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envVars: ['OPENAI_API_KEY'],
    modelEnvVars: ['OPENAI_MODEL'],
    apiHost: 'api.openai.com',
    modelsUrl: 'https://api.openai.com/v1/models',
    modelsJsonShape: 'data_id',
    authHeader: 'Authorization',
    authPrefix: 'Bearer',
    extraHeaders: {},
    rateLimitHeaderPrefix: 'x-ratelimit-',
    statusUrl: 'https://status.openai.com/api/v2/summary.json',
    statusFormat: 'statuspage_v2',
    docsUrl: 'https://platform.openai.com/docs/guides/error-codes',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    envVars: ['GOOGLE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    modelEnvVars: ['GEMINI_MODEL', 'GOOGLE_MODEL'],
    apiHost: 'generativelanguage.googleapis.com',
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    modelsJsonShape: 'models_name',
    // Google's models.list paginates (nextPageToken); see fetchModelList().
    paginated: true,
    authHeader: 'x-goog-api-key',
    authPrefix: '',
    extraHeaders: {},
    // Gemini does not publish ratelimit response headers — the headroom check
    // reports an honest `unknown` rather than guessing.
    statusUrl: 'https://status.cloud.google.com/incidents.json',
    statusFormat: 'google_cloud_incidents',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/troubleshooting',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    envVars: ['OPENROUTER_API_KEY'],
    modelEnvVars: ['OPENROUTER_MODEL'],
    apiHost: 'openrouter.ai',
    // The models list is public; key validity comes from the key-info
    // endpoint. OpenRouter's current API reference documents GET /api/v1/key
    // (response: { data: { limit, limit_remaining, limit_reset, usage } });
    // /api/v1/auth/key is not a documented endpoint. Step 5's curl re-confirms
    // this against the live provider before implementation — flip this one
    // line if OpenRouter's docs have changed again by then.
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    keyInfoUrl: 'https://openrouter.ai/api/v1/key',
    modelsJsonShape: 'data_id',
    authHeader: 'Authorization',
    authPrefix: 'Bearer',
    extraHeaders: {},
    docsUrl: 'https://openrouter.ai/docs/api-reference/limits',
  },
];

/**
 * Provider keys CrisisMode detects but has no llm-provider checks for. They
 * stay in AI_ENV_VARS so ai-provider's probe table and autodiscovery's stack
 * profile keep recognising them (the existing key set is preserved, not
 * narrowed).
 */
export const LEGACY_AI_ENV_VARS: Array<{ envVar: string; provider: string }> = [
  { envVar: 'COHERE_API_KEY', provider: 'cohere' },
  { envVar: 'MISTRAL_API_KEY', provider: 'mistral' },
  { envVar: 'REPLICATE_API_TOKEN', provider: 'replicate' },
  { envVar: 'HUGGINGFACE_API_KEY', provider: 'huggingface' },
];

/** Env-var detection list: llm-provider keys first, then preserved legacy keys. */
export const AI_ENV_VARS: Array<{ envVar: string; provider: string }> = [
  ...LLM_PROVIDERS.flatMap((spec) => spec.envVars.map((envVar) => ({ envVar, provider: spec.id as string }))),
  ...LEGACY_AI_ENV_VARS,
];

export function getProviderSpec(id: string): LlmProviderSpec | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id);
}

/**
 * Is this key configured? The single definition, used here and by
 * autodiscovery's provider detection (src/cli/autodiscovery.ts).
 *
 * A variable that is set but empty counts as NOT configured: exporting
 * `ANTHROPIC_API_KEY=` is how a shell ends up with a blank key, and treating
 * it as present would produce a live check that fails for a reason the user
 * cannot see. Both callers must agree, or a provider could be detected as
 * configured while no target is derived for it (or the reverse).
 */
export function hasConfiguredKey(env: NodeJS.ProcessEnv, envVar: string): boolean {
  return (env[envVar] ?? '') !== '';
}

/**
 * One entry per provider whose API key is present in `env`, in table order.
 * The first configured env var in a provider's list wins.
 *
 * SECURITY: returns env var NAMES, never values.
 */
export function detectConfiguredProviders(
  env: NodeJS.ProcessEnv,
): Array<{ provider: LlmProviderId; envVar: string; spec: LlmProviderSpec }> {
  const detected: Array<{ provider: LlmProviderId; envVar: string; spec: LlmProviderSpec }> = [];
  for (const spec of LLM_PROVIDERS) {
    const envVar = spec.envVars.find((name) => hasConfiguredKey(env, name));
    if (!envVar) continue;
    detected.push({ provider: spec.id, envVar, spec });
  }
  return detected;
}

/**
 * Render a key as a last-4 fingerprint for operator output. Keys shorter than
 * 8 characters are not fingerprinted at all — a 4-character suffix of a short
 * key is too much of the key.
 */
export function fingerprintKey(key: string): string {
  if (key.length < 8) return '(key too short to fingerprint)';
  return `…${key.slice(-4)}`;
}
