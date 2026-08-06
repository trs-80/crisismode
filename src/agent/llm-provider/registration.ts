// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { createLiveRegistration } from '../../config/live-registration.js';
import type { AgentRegistration } from '../../config/agent-registration.js';
import { llmProviderManifests } from './manifest.js';
import { getProviderSpec, hasConfiguredKey, type LlmProviderId } from './provider-table.js';
import { LlmProviderSimulator } from './simulator.js';

/**
 * One registration per provider, each under its own `llm-provider.<provider>`
 * kind — see the design doc's Maturity claim for why the kind must be
 * provider-scoped rather than a single shared `llm-provider` kind.
 */
function buildLlmProviderRegistration(providerId: LlmProviderId): AgentRegistration {
  const spec = getProviderSpec(providerId)!; // always defined — providerId is a valid LlmProviderId by construction

  return createLiveRegistration({
    kind: `llm-provider.${providerId}`,
    name: 'llm-provider-diagnosis',
    manifest: llmProviderManifests[providerId],
    loadAgent: async () => {
      const { LlmProviderDiagnosisAgent } = await import('./agent.js');
      return LlmProviderDiagnosisAgent as never;
    },
    // createLiveRegistration's loadSimulator contract constructs with no
    // arguments, so a demo target under this kind must get a simulator
    // already bound to this provider — otherwise every provider's demo
    // target would silently simulate 'anthropic' (LlmProviderSimulator's
    // default).
    loadSimulator: async () => {
      class BoundSimulator extends LlmProviderSimulator {
        constructor() {
          super('healthy', providerId);
        }
      }
      return BoundSimulator as never;
    },
    buildLiveBackend: async (target) => {
      if (target.llm?.provider !== undefined && target.llm.provider !== providerId) {
        throw new Error(
          `Target "${target.name}" is registered under kind "llm-provider.${providerId}" but its llm.provider is "llm-provider.${target.llm.provider}". Either use kind "llm-provider.${target.llm.provider}" for this target, or drop llm.provider to default to ${providerId}.`,
        );
      }

      // A missing key is a finding (key_present), not a construction failure —
      // an empty apiKey makes the client report it honestly instead of throwing.
      const envVar = spec.envVars.find((name) => hasConfiguredKey(process.env, name));

      const { LlmProviderLiveClient, DEFAULT_LLM_REQUEST_TIMEOUT_MS } = await import('./live-client.js');
      return new LlmProviderLiveClient({
        provider: spec.id,
        apiKey: envVar ? process.env[envVar]! : '',
        // Set explicitly, not left to the constructor default: scan gives each
        // agent 2000ms and replaces a timed-out assessment with an empty-signal
        // one, which would drop every checkId this agent exists to emit.
        timeoutMs: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
        ...(target.llm?.model !== undefined ? { configuredModel: target.llm.model } : {}),
      });
    },
  });
}

export const anthropicRegistration = buildLlmProviderRegistration('anthropic');
export const openaiRegistration = buildLlmProviderRegistration('openai');
export const googleRegistration = buildLlmProviderRegistration('google');
export const openrouterRegistration = buildLlmProviderRegistration('openrouter');

/** Provider-table order; builtin-agents.ts spreads this array. */
export const llmProviderRegistrations: AgentRegistration[] = [
  anthropicRegistration,
  openaiRegistration,
  googleRegistration,
  openrouterRegistration,
];
