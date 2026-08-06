// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import {
  LLM_PROVIDERS,
  AI_ENV_VARS,
  LEGACY_AI_ENV_VARS,
  detectConfiguredProviders,
  fingerprintKey,
  getProviderSpec,
  hasConfiguredKey,
} from '../agent/llm-provider/provider-table.js';

describe('llm-provider table', () => {
  it('covers exactly the four v1 providers', () => {
    expect(LLM_PROVIDERS.map((p) => p.id)).toEqual(['anthropic', 'openai', 'google', 'openrouter']);
  });

  it('lists google key env vars in priority order', () => {
    expect(getProviderSpec('google')!.envVars).toEqual([
      'GOOGLE_AI_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
    ]);
  });

  it('keeps apiHost consistent with modelsUrl for every provider', () => {
    for (const spec of LLM_PROVIDERS) {
      expect(new URL(spec.modelsUrl).hostname, `apiHost mismatch for ${spec.id}`).toBe(spec.apiHost);
    }
  });

  it('uses https for every endpoint it will call', () => {
    for (const spec of LLM_PROVIDERS) {
      for (const url of [spec.modelsUrl, spec.keyInfoUrl, spec.statusUrl]) {
        if (url) expect(url.startsWith('https://'), `${spec.id}: ${url}`).toBe(true);
      }
    }
  });

  it('AI_ENV_VARS is the llm-provider keys followed by the preserved legacy keys', () => {
    const names = AI_ENV_VARS.map((v) => v.envVar);
    expect(names).toContain('ANTHROPIC_API_KEY');
    expect(names).toContain('GEMINI_API_KEY');
    expect(names).toContain('OPENROUTER_API_KEY');
    // Existing key set preserved so ai-provider's probe table keeps detecting them.
    for (const legacy of ['COHERE_API_KEY', 'MISTRAL_API_KEY', 'REPLICATE_API_TOKEN', 'HUGGINGFACE_API_KEY']) {
      expect(names).toContain(legacy);
    }
    expect(new Set(names).size).toBe(names.length);
    expect(AI_ENV_VARS).toHaveLength(
      LLM_PROVIDERS.reduce((n, p) => n + p.envVars.length, 0) + LEGACY_AI_ENV_VARS.length,
    );
  });

  it('detects one entry per provider, honouring env var priority', () => {
    const detected = detectConfiguredProviders({
      GEMINI_API_KEY: 'g-key',
      GOOGLE_API_KEY: 'other-key',
      ANTHROPIC_API_KEY: 'sk-ant-key',
    } as NodeJS.ProcessEnv);
    expect(detected.map((d) => d.provider)).toEqual(['anthropic', 'google']);
    expect(detected.find((d) => d.provider === 'google')!.envVar).toBe('GEMINI_API_KEY');
  });

  it('ignores empty-string keys and returns nothing for an empty environment', () => {
    expect(detectConfiguredProviders({ OPENAI_API_KEY: '' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(detectConfiguredProviders({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('treats set-but-empty and unset identically, everywhere', () => {
    // One predicate, so autodiscovery's provider detection cannot disagree
    // with target derivation about what "configured" means.
    expect(hasConfiguredKey({ OPENAI_API_KEY: 'k' } as NodeJS.ProcessEnv, 'OPENAI_API_KEY')).toBe(true);
    expect(hasConfiguredKey({ OPENAI_API_KEY: '' } as NodeJS.ProcessEnv, 'OPENAI_API_KEY')).toBe(false);
    expect(hasConfiguredKey({} as NodeJS.ProcessEnv, 'OPENAI_API_KEY')).toBe(false);
  });

  it('fingerprints a key to its last four characters only', () => {
    expect(fingerprintKey('sk-ant-api03-SUPERSECRET-9f3a')).toBe('…9f3a');
  });

  it('refuses to fingerprint a key too short to redact', () => {
    expect(fingerprintKey('abc')).toBe('(key too short to fingerprint)');
    expect(fingerprintKey('abc')).not.toContain('abc');
  });
});
