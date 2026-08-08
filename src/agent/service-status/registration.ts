// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import { resolveCatalogEntry } from '../../framework/service-status/catalog.js';
import type { ServiceTarget } from '../../framework/service-status/checker.js';
import { serviceStatusManifest } from './manifest.js';

export const serviceStatusRegistration = createLiveRegistration({
  kind: 'service-status',
  name: 'service-status-diagnosis',
  manifest: serviceStatusManifest,
  loadAgent: async () => {
    const { ServiceStatusAgent } = await import('./agent.js');
    return ServiceStatusAgent as never;
  },
  loadSimulator: async () => {
    const { ServiceStatusSimulator } = await import('./simulator.js');
    return ServiceStatusSimulator as never;
  },
  buildLiveBackend: async (target) => {
    // One instance checks exactly the one service `serviceTargetsFromConfig`
    // (src/cli/service-targets.ts) gave this target. The catalog entry is
    // re-resolved from the target's name rather than threaded through
    // TargetConfig — schema.ts has no field for it, and resolveTarget()
    // (config/resolve.ts) copies fields by name, so an untracked field would
    // silently vanish there.
    const entry = resolveCatalogEntry(target.name);
    const serviceTarget: ServiceTarget = entry
      ? { id: entry.id, entry }
      : { id: target.name, host: target.primary.host, port: target.primary.port };
    const { ServiceStatusLiveClient } = await import('./live-client.js');
    return new ServiceStatusLiveClient([serviceTarget]);
  },
});
