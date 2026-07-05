// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { buildProviderConfigs, AI_ENV_VARS, PROVIDER_PROBE_TABLE } from '../agent/ai-provider/provider-table.js';

describe('AI provider probe table', () => {
  it('builds configs only for providers whose env key is present, in table order', () => {
    const configs = buildProviderConfigs({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      MISTRAL_API_KEY: 'test-mistral',
    } as NodeJS.ProcessEnv);
    expect(configs.map((c) => c.name)).toEqual(['anthropic', 'mistral']);
    expect(configs[0].priority).toBeLessThan(configs[1].priority);
    expect(configs.every((c) => c.enabled)).toBe(true);
  });

  it('returns empty when no keys are set', () => {
    expect(buildProviderConfigs({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('configures anthropic with x-api-key, no prefix, and a version header', () => {
    const [anthropic] = buildProviderConfigs({ ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv);
    expect(anthropic.authHeader).toBe('x-api-key');
    expect(anthropic.authPrefix).toBe('');
    expect(anthropic.extraHeaders?.['anthropic-version']).toBeTruthy();
  });

  it('AI_ENV_VARS mirrors the probe table', () => {
    expect(AI_ENV_VARS).toHaveLength(PROVIDER_PROBE_TABLE.length);
    expect(AI_ENV_VARS.map((v) => v.provider)).toContain('openai');
  });
});
