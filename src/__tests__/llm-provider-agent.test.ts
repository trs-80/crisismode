// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { llmProviderManifest } from '../agent/llm-provider/manifest.js';
import { isKnownCapability } from '../framework/capability-registry.js';
import { explainSource } from '../framework/signal-explanations.js';

describe('llmProviderManifest', () => {
  it('claims live_validated maturity at routine risk', () => {
    expect(llmProviderManifest.metadata.plugin.maturity).toBe('live_validated');
    expect(llmProviderManifest.spec.riskProfile.maxRiskLevel).toBe('routine');
    expect(llmProviderManifest.spec.riskProfile.dataLossPossible).toBe(false);
    expect(llmProviderManifest.spec.riskProfile.serviceDisruptionPossible).toBe(false);
  });

  it('declares only read privilege — this agent never mutates', () => {
    for (const ctx of llmProviderManifest.spec.executionContexts) {
      expect(ctx.privilege).toBe('read');
    }
  });

  it('registers every capability it declares', () => {
    for (const ctx of llmProviderManifest.spec.executionContexts) {
      for (const capability of ctx.capabilities ?? []) {
        expect(isKnownCapability(capability), `unregistered capability ${capability}`).toBe(true);
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
