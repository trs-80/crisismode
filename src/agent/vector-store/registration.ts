// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { vectorStoreManifest } from './manifest.js';
import { buildVectorStoreConnections, VECTOR_STORE_PROVIDERS } from './provider-table.js';

export const vectorStoreRegistration = createLiveRegistration({
  kind: 'vector-store',
  name: 'vector-store-diagnosis',
  manifest: vectorStoreManifest,
  loadAgent: async () => {
    const { VectorStoreAgent } = await import('./agent.js');
    return VectorStoreAgent as never;
  },
  loadSimulator: async () => {
    const { VectorStoreSimulator } = await import('./simulator.js');
    return VectorStoreSimulator as never;
  },
  buildLiveBackend: async () => {
    const connections = buildVectorStoreConnections(process.env);
    if (connections.length === 0) {
      // Fail loud: silently simulating would claim coverage that doesn't exist.
      const checked = VECTOR_STORE_PROVIDERS.flatMap((p) =>
        [p.keyEnvVar, ...(p.urlEnvVar ? [p.urlEnvVar] : [])]).join(', ');
      throw new Error(
        `No vector-store credentials found in environment (checked ${checked}). ` +
          'Upstash Vector needs both UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN.',
      );
    }
    const { VectorStoreLiveClient, DEFAULT_TIMEOUT_MS } = await import('./live-client.js');
    // Timeout set explicitly at the wiring point, not left to the default:
    // scan's per-agent budget is what makes this number correct, and that
    // constraint is invisible from inside the client.
    return new VectorStoreLiveClient({ connections, timeoutMs: DEFAULT_TIMEOUT_MS });
  },
});
