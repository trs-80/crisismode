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
        // @ts-expect-error -- live-client.ts does not exist until Task 7 lands;
        // the import throws module-not-found at runtime and hits the catch
        // below, which is the intended interim behavior on this branch.
        const { IacDriftLiveClient } = await import('./live-client.js');
        const backend = new IacDriftLiveClient({ dir });
        const agent = new IacDriftRecoveryAgent(backend);
        return { agent, backend, target };
      } catch (err) {
        // Only the dynamic import()/construction is guarded here; the live
        // client defers all filesystem/AWS I/O to query time, so real
        // read/auth failures surface later, not in this catch. Never swallow
        // silently. Until Task 7 lands, this import always throws
        // module-not-found and hits this fallback — expected interim
        // behavior on this branch.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `iac-drift live client initialization failed for target "${target.name}" (${message}). ` +
            `Falling back to the simulator — drift results will NOT reflect the real Terraform state.`,
        );
      }
    }

    const { IacDriftSimulator } = await import('./simulator.js');
    const backend = new IacDriftSimulator();
    const agent = new IacDriftRecoveryAgent(backend);
    return { agent, backend, target };
  },
};
