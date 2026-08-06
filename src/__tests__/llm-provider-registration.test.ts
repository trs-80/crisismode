// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect, afterEach } from 'vitest';
import {
  anthropicRegistration,
  googleRegistration,
  llmProviderRegistrations,
} from '../agent/llm-provider/registration.js';
import { builtinAgents } from '../config/builtin-agents.js';
import { LlmProviderSimulator } from '../agent/llm-provider/simulator.js';
import { LlmProviderLiveClient, DEFAULT_LLM_REQUEST_TIMEOUT_MS } from '../agent/llm-provider/live-client.js';
import { AGENT_TIMEOUT_MS } from '../cli/commands/scan.js';
import { resolveTarget } from '../config/resolve.js';

const originalKey = process.env['ANTHROPIC_API_KEY'];
afterEach(() => {
  if (originalKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = originalKey;
});

describe('llm-provider registrations', () => {
  it('registers one built-in agent per provider-scoped kind', () => {
    expect(llmProviderRegistrations).toHaveLength(4);
    expect(llmProviderRegistrations.map((r) => r.kind)).toEqual([
      'llm-provider.anthropic',
      'llm-provider.openai',
      'llm-provider.google',
      'llm-provider.openrouter',
    ]);
    for (const kind of llmProviderRegistrations.map((r) => r.kind)) {
      expect(builtinAgents.map((a) => a.kind)).toContain(kind);
    }
    expect(llmProviderRegistrations.every((r) => r.name === 'llm-provider-diagnosis')).toBe(true);
  });

  it('gives each provider-scoped kind its own manifest maturity', () => {
    const maturity = (kind: string) =>
      builtinAgents.find((a) => a.kind === kind)!.manifest.metadata.plugin.maturity;
    expect(maturity('llm-provider.anthropic')).toBe('live_validated');
    expect(maturity('llm-provider.openai')).toBe('live_validated');
    expect(maturity('llm-provider.google')).toBe('simulator_only');
    expect(maturity('llm-provider.openrouter')).toBe('simulator_only');
  });

  it('keeps ai-provider registered for explicit config and demo mode', () => {
    expect(builtinAgents.map((a) => a.kind)).toContain('ai-provider');
  });

  it('uses the simulator for an explicit simulator target, bound to the registration\'s own provider', async () => {
    const target = resolveTarget({ name: 'demo', kind: 'llm-provider.google', primary: { host: 'simulator', port: 0 } });
    const instance = await googleRegistration.createAgent(target);
    expect(instance.backend).toBeInstanceOf(LlmProviderSimulator);
    // Regression guard: createLiveRegistration's loadSimulator constructs with
    // no arguments, so a naive re-export of LlmProviderSimulator would default
    // every provider's demo target to 'anthropic'. The google registration
    // must wrap the simulator so its demo target simulates google.
    expect((instance.backend as LlmProviderSimulator).getProviderId()).toBe('google');
  });

  it('builds a live client for a real target, carrying provider and model', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-registration-test';
    const target = resolveTarget({
      name: 'derived-llm-anthropic',
      kind: 'llm-provider.anthropic',
      primary: { host: 'api.anthropic.com', port: 443 },
      llm: { model: 'claude-sonnet-4-5' },
    });
    const instance = await anthropicRegistration.createAgent(target);
    expect(instance.backend).toBeInstanceOf(LlmProviderLiveClient);
    expect((instance.backend as LlmProviderLiveClient).getProviderId()).toBe('anthropic');
  });

  it('gives the live client a timeout that fits inside scan\'s per-agent budget', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-registration-test';
    const target = resolveTarget({
      name: 'derived-llm-anthropic',
      kind: 'llm-provider.anthropic',
      primary: { host: 'api.anthropic.com', port: 443 },
    });
    const instance = await anthropicRegistration.createAgent(target);
    // The client keeps its config on a readonly field; assert the wiring rather
    // than re-deriving the number.
    const config = (instance.backend as unknown as { config: { timeoutMs?: number } }).config;
    expect(config.timeoutMs).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(config.timeoutMs!).toBeLessThan(AGENT_TIMEOUT_MS);
  });

  it('defaults to its own provider when the target names none', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-registration-test';
    const target = resolveTarget({
      name: 'derived-llm-anthropic',
      kind: 'llm-provider.anthropic',
      primary: { host: 'api.anthropic.com', port: 443 },
    });
    const instance = await anthropicRegistration.createAgent(target);
    expect((instance.backend as LlmProviderLiveClient).getProviderId()).toBe('anthropic');
  });

  it('fails loudly when the target\'s llm.provider conflicts with the registration\'s own kind', async () => {
    const target = resolveTarget({
      name: 'misfiled',
      kind: 'llm-provider.anthropic',
      primary: { host: 'api.anthropic.com', port: 443 },
      llm: { provider: 'openai' },
    });
    await expect(anthropicRegistration.createAgent(target)).rejects.toThrow(/llm-provider\.openai/);
  });

  it('does not throw when the key is absent — a missing key is a finding, not a crash', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const target = resolveTarget({
      name: 'derived-llm-anthropic',
      kind: 'llm-provider.anthropic',
      primary: { host: 'api.anthropic.com', port: 443 },
    });
    const instance = await anthropicRegistration.createAgent(target);
    const presence = await (instance.backend as LlmProviderLiveClient).checkKeyPresence();
    expect(presence.present).toBe(false);
  });
});
