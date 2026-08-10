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
 *
 * Refusals come in two flavours, because the operator's next action differs:
 * a target that names real infrastructure vs. a target that names nothing at
 * all (config omitted `primary`). Both throw; only the first has an endpoint
 * worth quoting back.
 */

import type { AgentRegistration, AgentInstance } from './agent-registration.js';
import type { AgentManifest } from '../types/manifest.js';
import type { RecoveryAgent } from '../agent/interface.js';
import type { ExecutionBackend } from '../framework/backend.js';
import type { ResolvedTarget } from './schema.js';
import { isSimulatorTarget, SIMULATOR_HOST } from './simulator-target.js';

/**
 * The target declared no `primary`, so `resolveTarget()` stamped the internal
 * `{ host: 'aws', port: 0 }` placeholder. Refusing is still right — nobody
 * pointed us at anything — but the placeholder must never reach the operator:
 * `aws:0` is an artifact of the resolver, it implies AWS is involved when it
 * is not, and it buries the actual problem. Say what is actually wrong.
 *
 * Defence in depth for these four kinds specifically: a `crisismode.yaml`
 * omitting `primary` is already rejected earlier by `validateTarget()`
 * (config/loader.ts:375-382, which exempts only `aws-*` kinds). This branch
 * covers callers that build a `SiteConfig` in memory and hand it straight to
 * `AgentRegistry` — that constructor calls `resolveTargets()` directly
 * (config/agent-registry.ts:36) and never runs loader validation.
 *
 * The wording therefore avoids naming crisismode.yaml: the reachable caller
 * may not have one.
 */
function refuseWithoutHost(kind: string, target: ResolvedTarget): Error {
  return new Error(
    `No primary host configured for ${kind} target "${target.name}": the target was declared ` +
      `without a primary block, so CrisisMode was never told what to look at. ` +
      `Either set \`primary.host: ${SIMULATOR_HOST}\` on this target to exercise the ${kind} simulator ` +
      `deliberately (or run \`crisismode demo\`), or give it a real \`primary\` host — though note the ` +
      `${kind} agent is simulator-only today, so there is no live client to reach a real host with ` +
      `until one ships.`,
  );
}

/**
 * The target names infrastructure we have no live client for. Only reachable
 * for targets `isSimulatorTarget()` rejected, so `target.primary` is a real
 * configured endpoint here, safe to quote back.
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
        throw target.primaryDefaulted
          ? refuseWithoutHost(opts.kind, target)
          : refuseToFabricate(opts.kind, target);
      }

      const AgentClass = await opts.loadAgent();
      const SimulatorClass = await opts.loadSimulator();

      const backend = new SimulatorClass();
      const agent = new AgentClass(backend);
      return { agent, backend, target };
    },
  };
}
