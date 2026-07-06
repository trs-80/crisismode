// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { configDriftManifest } from './manifest.js';

export const configDriftRegistration = createLiveRegistration({
  kind: 'application-config',
  name: 'config-drift-recovery',
  manifest: configDriftManifest,
  loadAgent: async () => {
    const { ConfigDriftAgent } = await import('./agent.js');
    return ConfigDriftAgent as never;
  },
  loadSimulator: async () => {
    const { ConfigDriftSimulator } = await import('./simulator.js');
    return ConfigDriftSimulator as never;
  },
  buildLiveBackend: async (target) => {
    const { ConfigDriftLiveClient } = await import('./live-client.js');
    const { buildPresenceExpectations } = await import('./env-example.js');
    const opts = target.configDrift;

    // YAML-declared value expectations pass through unchanged.
    const yamlExpectations = (opts?.expectations ?? []).map((e) => ({
      path: e.path,
      expected: e.expected,
      source: e.source,
      masked: e.masked,
    }));

    // Zero-config: presence-only expectations from .env.example.
    const presenceExpectations = await buildPresenceExpectations(process.cwd(), opts?.envExamplePath);

    const expectations = [...yamlExpectations, ...presenceExpectations];
    if (expectations.length === 0) {
      throw new Error(
        'No config expectations available: no .env.example/.env.template found and none declared in crisismode.yaml',
      );
    }

    return new ConfigDriftLiveClient({ expectations });
  },
});
