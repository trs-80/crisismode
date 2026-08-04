// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { AgentRegistration } from '../../config/agent-registration.js';
import { iacDriftManifest } from './manifest.js';

export const iacDriftRegistration: AgentRegistration = {
  kind: 'iac-drift',
  name: 'iac-drift-recovery',
  manifest: iacDriftManifest,

  async createAgent(target) {
    const { IacDriftRecoveryAgent } = await import('./agent.js');
    const dir = target.iac?.dir ?? process.cwd();

    if (dir !== 'simulator') {
      try {
        const { IacDriftLiveClient } = await import('./live-client.js');
        const backend = new IacDriftLiveClient({ dir });
        const agent = new IacDriftRecoveryAgent(backend);
        return { agent, backend, target };
      } catch (err) {
        // Only the dynamic import()/construction is guarded here; the live
        // client defers all filesystem/AWS I/O to query time, so real
        // read/auth failures surface later, not in this catch. Never swallow
        // silently — this only catches genuine construction errors (e.g. a
        // corrupt module).
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `iac-drift live client initialization failed for target "${target.name}" (${message}). ` +
            `Falling back to a "state unreadable" simulator — no drift findings will be fabricated for this real project.`,
        );
        const { IacDriftSimulator } = await import('./simulator.js');
        const backend = new IacDriftSimulator('state_unreadable');
        const agent = new IacDriftRecoveryAgent(backend);
        return { agent, backend, target };
      }
    }

    // dir === 'simulator': explicit demo mode — the default 'drifted'
    // scenario is intentional here, unlike the failure fallback above.
    const { IacDriftSimulator } = await import('./simulator.js');
    const backend = new IacDriftSimulator();
    const agent = new IacDriftRecoveryAgent(backend);
    return { agent, backend, target };
  },
};
