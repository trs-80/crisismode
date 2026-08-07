// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Static table for managed vector stores: which env vars carry credentials
 * and which REST endpoint answers the reachability/auth/index checks. Single
 * source of truth for both the live client and autodiscovery detection.
 *
 * SECURITY: the values of these env vars are credentials. They are read at
 * backend-construction time, handed straight to the live client, and never
 * logged, stored on a finding, or written to forensics — only the provider
 * name and a last-4 fingerprint ever appear in output.
 */

export type VectorStoreProvider = 'pinecone' | 'upstash-vector';

export interface VectorStoreProviderSpec {
  provider: VectorStoreProvider;
  /** Env var carrying the API key / bearer token. */
  keyEnvVar: string;
  /** Env var carrying the base REST URL; omitted when the endpoint is fixed. */
  urlEnvVar?: string;
  /** Fixed control-plane base URL; omitted when the URL comes from `urlEnvVar`. */
  baseUrl?: string;
}

export const VECTOR_STORE_PROVIDERS: VectorStoreProviderSpec[] = [
  { provider: 'pinecone', keyEnvVar: 'PINECONE_API_KEY', baseUrl: 'https://api.pinecone.io' },
  {
    provider: 'upstash-vector',
    keyEnvVar: 'UPSTASH_VECTOR_REST_TOKEN',
    urlEnvVar: 'UPSTASH_VECTOR_REST_URL',
  },
];

/** Env-var detection list for autodiscovery, derived from the table above. */
export const VECTOR_STORE_ENV_VARS: Array<{ envVar: string; provider: VectorStoreProvider }> =
  VECTOR_STORE_PROVIDERS.flatMap((spec) => [
    { envVar: spec.keyEnvVar, provider: spec.provider },
    ...(spec.urlEnvVar ? [{ envVar: spec.urlEnvVar, provider: spec.provider }] : []),
  ]);

export interface VectorStoreConnection {
  provider: VectorStoreProvider;
  baseUrl: string;
  apiKey: string;
}

/**
 * One connection per provider that is FULLY configured in `env`. Upstash needs
 * both its URL and its token — a half-configured provider is skipped rather
 * than probed against a guessed URL.
 */
export function buildVectorStoreConnections(env: NodeJS.ProcessEnv): VectorStoreConnection[] {
  const connections: VectorStoreConnection[] = [];
  for (const spec of VECTOR_STORE_PROVIDERS) {
    const apiKey = env[spec.keyEnvVar];
    if (!apiKey) continue;
    const baseUrl = spec.baseUrl ?? (spec.urlEnvVar ? env[spec.urlEnvVar] : undefined);
    if (!baseUrl) continue;
    connections.push({
      provider: spec.provider,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey,
    });
  }
  return connections;
}
