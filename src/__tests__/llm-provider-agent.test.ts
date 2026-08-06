// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { buildLlmProviderManifest, llmProviderManifests } from '../agent/llm-provider/manifest.js';
import type { LlmProviderId } from '../agent/llm-provider/provider-table.js';
import { isKnownCapability } from '../framework/capability-registry.js';
import { explainSource } from '../framework/signal-explanations.js';

describe('llmProviderManifest', () => {
  it('builds manifests for all four providers with per-provider maturity', () => {
    const expectations: Record<LlmProviderId, 'live_validated' | 'simulator_only'> = {
      anthropic: 'live_validated',
      openai: 'live_validated',
      google: 'simulator_only',
      openrouter: 'simulator_only',
    };

    for (const [provider, expectedMaturity] of Object.entries(expectations)) {
      const manifest = llmProviderManifests[provider as LlmProviderId];
      expect(manifest, `manifest missing for ${provider}`).toBeDefined();
      expect(manifest.metadata.plugin.maturity).toBe(expectedMaturity);
      expect(manifest.metadata.plugin.id).toBe(`llm-provider.${provider}`);
    }
  });

  it('buildLlmProviderManifest returns consistent results (deterministic)', () => {
    const m1 = buildLlmProviderManifest('anthropic');
    const m2 = buildLlmProviderManifest('anthropic');
    expect(JSON.stringify(m1)).toBe(JSON.stringify(m2));
  });

  it('claims live_validated maturity at routine risk for validated providers', () => {
    const manifest = llmProviderManifests.anthropic;
    expect(manifest.metadata.plugin.maturity).toBe('live_validated');
    expect(manifest.spec.riskProfile.maxRiskLevel).toBe('routine');
    expect(manifest.spec.riskProfile.dataLossPossible).toBe(false);
    expect(manifest.spec.riskProfile.serviceDisruptionPossible).toBe(false);
  });

  it('declares only read privilege — this agent never mutates', () => {
    for (const manifest of Object.values(llmProviderManifests)) {
      for (const ctx of manifest.spec.executionContexts) {
        expect(ctx.privilege).toBe('read');
      }
    }
  });

  it('registers every capability it declares', () => {
    for (const manifest of Object.values(llmProviderManifests)) {
      for (const ctx of manifest.spec.executionContexts) {
        for (const capability of ctx.capabilities ?? []) {
          expect(isKnownCapability(capability), `unregistered capability ${capability}`).toBe(true);
        }
      }
    }
  });

  it('has a plain-language explanation for every signal source it emits', () => {
    for (const source of [
      'llm_key_present',
      'llm_key_valid',
      'llm_quota_billing',
      'llm_rate_limit_headroom',
      'llm_model_deprecated',
      'llm_provider_status',
    ]) {
      expect(explainSource(source), `no EXPLANATIONS entry for ${source}`).toBeDefined();
    }
  });
});
