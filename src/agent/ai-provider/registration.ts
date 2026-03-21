// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createSimulatorRegistration } from '../../config/simulator-registration.js';
import { aiProviderManifest } from './manifest.js';

export const aiProviderRegistration = createSimulatorRegistration({
  kind: 'ai-provider',
  name: 'ai-provider-failover-recovery',
  manifest: aiProviderManifest,
  loadAgent: async () => {
    const { AiProviderFailoverAgent } = await import('./agent.js');
    return AiProviderFailoverAgent as any;
  },
  loadSimulator: async () => {
    const { AiProviderSimulator } = await import('./simulator.js');
    return AiProviderSimulator as any;
  },
});
