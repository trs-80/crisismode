// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Factory for creating simulator-only agent registrations.
 * Eliminates boilerplate for agents that don't yet have a live client.
 */

import type { AgentRegistration, AgentInstance } from './agent-registration.js';
import type { AgentManifest } from '../types/manifest.js';
import type { RecoveryAgent } from '../agent/interface.js';
import type { ExecutionBackend } from '../framework/backend.js';

/**
 * Create an AgentRegistration that uses a simulator backend.
 * The agent and simulator are lazily imported at creation time.
 */
export function createSimulatorRegistration(opts: {
  kind: string;
  name: string;
  manifest: AgentManifest;
  loadAgent: () => Promise<{ new (backend: ExecutionBackend): RecoveryAgent }>;
  loadSimulator: () => Promise<{ new (): ExecutionBackend }>;
}): AgentRegistration {
  return {
    kind: opts.kind,
    name: opts.name,
    manifest: opts.manifest,

    async createAgent(target): Promise<AgentInstance> {
      const AgentClass = await opts.loadAgent();
      const SimulatorClass = await opts.loadSimulator();

      const backend = new SimulatorClass();
      const agent = new AgentClass(backend);
      return { agent, backend, target };
    },
  };
}
