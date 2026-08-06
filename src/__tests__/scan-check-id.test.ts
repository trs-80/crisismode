// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { describe, it, expect } from 'vitest';
import { checkTargetHealth, dominantCheckId } from '../cli/commands/scan.js';
import { LlmProviderDiagnosisAgent } from '../agent/llm-provider/agent.js';
import { LlmProviderSimulator } from '../agent/llm-provider/simulator.js';
import { LLM_PROVIDER_CHECK_IDS } from '../agent/llm-provider/check-ids.js';
import type { TargetConfig } from '../config/schema.js';

describe('dominantCheckId', () => {
  it('prefers the first failing signal that carries a check id', () => {
    expect(dominantCheckId([
      { status: 'healthy', checkId: 'llm-provider.key_present' },
      { status: 'critical', checkId: 'llm-provider.key_valid' },
      { status: 'warning', checkId: 'llm-provider.provider_status' },
    ])).toBe('llm-provider.key_valid');
  });

  it('falls back to the first signal with a check id when nothing is failing', () => {
    expect(dominantCheckId([{ status: 'healthy', checkId: 'llm-provider.key_present' }]))
      .toBe('llm-provider.key_present');
  });

  it('returns undefined for agents that have not adopted check ids', () => {
    expect(dominantCheckId([{ status: 'critical' }])).toBeUndefined();
    expect(dominantCheckId([])).toBeUndefined();
  });
});

describe('checkTargetHealth check ids', () => {
  const target: TargetConfig = {
    name: 'derived-llm-anthropic',
    kind: 'llm-provider.anthropic',
    primary: { host: 'simulator', port: 0 },
  };

  function registry(scenario: 'bad_key' | 'healthy') {
    return {
      supportedKinds: () => ['llm-provider.anthropic'],
      createForTarget: async () => {
        const backend = new LlmProviderSimulator(scenario, 'anthropic');
        return { agent: new LlmProviderDiagnosisAgent(backend, async () => null), backend, target: target as never };
      },
    };
  }

  it('carries the failing check id on the finding and on each signal', async () => {
    const result = await checkTargetHealth(target, registry('bad_key') as never);
    expect(result.finding.checkId).toBe(LLM_PROVIDER_CHECK_IDS.keyValid);
    expect(result.finding.signals.map((s) => s.checkId)).toContain(LLM_PROVIDER_CHECK_IDS.quotaBilling);
  });

  it('leaves checkId undefined for a healthy-but-unadopted agent shape', async () => {
    const plainRegistry = {
      supportedKinds: () => ['llm-provider.anthropic'],
      createForTarget: async () => ({
        agent: {
          manifest: new LlmProviderDiagnosisAgent().manifest,
          assessHealth: async () => ({
            status: 'healthy' as const,
            confidence: 1,
            summary: 'ok',
            observedAt: new Date().toISOString(),
            signals: [{ source: 'legacy_signal', status: 'healthy' as const, detail: 'fine', observedAt: new Date().toISOString() }],
            recommendedActions: [],
          }),
          diagnose: async () => ({ status: 'inconclusive' as const, scenario: null, confidence: 1, findings: [], diagnosticPlanNeeded: false }),
        },
        backend: { close: async () => {} },
        target: target as never,
      }),
    };
    const result = await checkTargetHealth(target, plainRegistry as never);
    expect(result.finding.checkId).toBeUndefined();
  });
});
