// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { aiProviderManifest } from './manifest.js';
import { buildProviderConfigs } from './provider-table.js';

export const aiProviderRegistration = createLiveRegistration({
  kind: 'ai-provider',
  name: 'ai-provider-failover-recovery',
  manifest: aiProviderManifest,
  loadAgent: async () => {
    const { AiProviderFailoverAgent } = await import('./agent.js');
    return AiProviderFailoverAgent as never;
  },
  loadSimulator: async () => {
    const { AiProviderSimulator } = await import('./simulator.js');
    return AiProviderSimulator as never;
  },
  buildLiveBackend: async () => {
    const providers = buildProviderConfigs(process.env);
    if (providers.length === 0) {
      throw new Error(
        'No AI provider API keys found in environment (checked OPENAI_API_KEY, ANTHROPIC_API_KEY, COHERE_API_KEY, GOOGLE_AI_API_KEY, MISTRAL_API_KEY, REPLICATE_API_TOKEN, HUGGINGFACE_API_KEY)',
      );
    }
    const { AiProviderLiveClient } = await import('./live-client.js');
    return new AiProviderLiveClient({ providers });
  },
});
