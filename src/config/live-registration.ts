// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Factory for agent registrations that have a real live client.
 *
 * Policy (credibility standard — owned here, in exactly one place):
 * - Explicit simulator targets (host === 'simulator', or no primary) get the
 *   simulator backend. This is the demo/test path.
 * - Every other target gets the live backend. Connection failures PROPAGATE
 *   to the caller so scan reports an honest "could not connect" finding.
 *   We never silently substitute simulated data for real systems.
 */

import type { AgentRegistration, AgentInstance } from './agent-registration.js';
import type { AgentManifest } from '../types/manifest.js';
import type { RecoveryAgent } from '../agent/interface.js';
import type { ExecutionBackend } from '../framework/backend.js';
import type { ResolvedTarget } from './schema.js';

export function createLiveRegistration(opts: {
  kind: string;
  name: string;
  manifest: AgentManifest;
  loadAgent: () => Promise<{ new (backend: ExecutionBackend): RecoveryAgent }>;
  loadSimulator: () => Promise<{ new (): ExecutionBackend }>;
  /** Build and connect the live backend. Throw on failure — never swallow. */
  buildLiveBackend: (target: ResolvedTarget) => Promise<ExecutionBackend>;
}): AgentRegistration {
  return {
    kind: opts.kind,
    name: opts.name,
    manifest: opts.manifest,

    async createAgent(target): Promise<AgentInstance> {
      const AgentClass = await opts.loadAgent();

      const isSimulatorTarget = !target.primary || target.primary.host === 'simulator';
      let backend: ExecutionBackend;
      if (isSimulatorTarget) {
        const SimulatorClass = await opts.loadSimulator();
        backend = new SimulatorClass();
      } else {
        backend = await opts.buildLiveBackend(target);
      }

      const agent = new AgentClass(backend);
      return { agent, backend, target };
    },
  };
}
