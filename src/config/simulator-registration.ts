// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Factory for creating simulator-only agent registrations — agents that have
 * no live client yet (ceph, etcd, flink, kafka).
 *
 * Policy (the same credibility standard live-registration.ts owns):
 * - Explicit simulator targets (host === 'simulator', or no primary) get the
 *   simulator backend. This is the demo/test path.
 * - Every other target is REFUSED. There is no live client to fall back to,
 *   so the only alternatives are "throw" and "hand the operator invented
 *   numbers about their production cluster." We never silently substitute
 *   simulated data for real systems. The throw carries the explanation, and
 *   callers (cli/commands/scan.ts, mcp/server.ts) turn it into an honest
 *   `unknown` finding rather than a fabricated healthy/degraded one.
 */

import type { AgentRegistration, AgentInstance } from './agent-registration.js';
import type { AgentManifest } from '../types/manifest.js';
import type { RecoveryAgent } from '../agent/interface.js';
import type { ExecutionBackend } from '../framework/backend.js';
import type { ResolvedTarget } from './schema.js';
import { isSimulatorTarget, SIMULATOR_HOST } from './simulator-target.js';

/**
 * Only reachable for targets `isSimulatorTarget()` rejected, which is exactly
 * the set that has a `primary` naming something other than the simulator — so
 * `target.primary` is safe to read here.
 */
function refuseToFabricate(kind: string, target: ResolvedTarget): Error {
  const endpoint = `${target.primary.host}:${target.primary.port}`;
  return new Error(
    `No live client for ${kind}: the ${kind} agent is simulator-only, so CrisisMode cannot observe ` +
      `target "${target.name}" at ${endpoint}. Refusing to run — reporting simulated ${kind} data as ` +
      `if it came from your infrastructure would be worse than reporting nothing. ` +
      `To exercise the ${kind} simulator deliberately, set this target's primary.host to '${SIMULATOR_HOST}' ` +
      `in crisismode.yaml, or run \`crisismode demo\`. To monitor the real system, remove the ${kind} ` +
      `target until a live client ships.`,
  );
}

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
      if (!isSimulatorTarget(target)) {
        throw refuseToFabricate(opts.kind, target);
      }

      const AgentClass = await opts.loadAgent();
      const SimulatorClass = await opts.loadSimulator();

      const backend = new SimulatorClass();
      const agent = new AgentClass(backend);
      return { agent, backend, target };
    },
  };
}
